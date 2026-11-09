from contextlib import ExitStack
from pathlib import Path
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scheduling_cortex import dispatch
from scheduling_cortex.storage import ScheduleStorage, StorageConfig


@pytest.fixture
def delivery(tmp_path):
    store = ScheduleStorage(StorageConfig(db_path=str(tmp_path / 'scheduler.db')))
    task = {'id': 'synthetic-schedule', '_scheduled_prompt_run_id': 'synthetic-run'}
    prefs = {'voice_responses_enabled': True, 'always_voice_response': True}
    events = []
    with ExitStack() as stack:
        stack.enter_context(patch.object(dispatch, '_scheduler_storage', return_value=store))
        stack.enter_context(patch.object(dispatch, '_get_telegram_bot_token', return_value='synthetic'))
        stack.enter_context(patch.object(dispatch, '_resolve_telegram_identity',
            return_value=('synthetic-user', 'synthetic-chat', prefs)))
        text = stack.enter_context(patch.object(dispatch, '_send_telegram_message',
            side_effect=lambda *args: events.append('text') or f'text-{len(events)}'))
        tts = stack.enter_context(patch.object(dispatch, '_synthesize_tts', return_value=b'synthetic-audio'))
        audio = stack.enter_context(patch.object(dispatch, '_send_telegram_audio',
            side_effect=lambda *args: events.append('audio') or 'audio-1'))
        def send(answer='Useful answer.', followup=''):
            return dispatch._deliver_telegram_generated_text(task, 'http://localhost', 5, None,
                dispatch._prepare_generated_visibility(task, answer, followup))
        yield store, prefs, events, text, tts, audio, send


def rows(store):
    with store._connect() as conn:
        return [dict(row) for row in conn.execute(
            'SELECT * FROM scheduled_prompt_deliveries ORDER BY part_index')]


def test_text_precedes_one_audio_for_the_complete_answer_and_replay_sends_nothing(delivery):
    store, prefs, events, text, tts, audio, send = delivery
    first = send('A' * 4100, 'One follow-up.')
    assert events == ['text', 'text', 'text', 'audio']
    assert tts.call_count == 1
    assert tts.call_args.args[0] == 'A' * 4100 + '\n\nOne follow-up.'
    assert len(first['telegram_message_ids']) == 4
    assert [row['state'] for row in rows(store)] == ['sent'] * 4
    second = send('A' * 4100, 'One follow-up.')
    assert second['telegram_message_ids'] == first['telegram_message_ids']
    assert events == ['text', 'text', 'text', 'audio']
    assert tts.call_count == 1


def test_crash_before_audio_claim_resumes_only_audio(delivery):
    store, prefs, events, text, tts, audio, send = delivery
    claim = store.claim_scheduled_prompt_delivery
    def crash(**kwargs):
        if kwargs['part_index'] == 1:
            raise RuntimeError('synthetic pre-send interruption')
        return claim(**kwargs)
    with patch.object(store, 'claim_scheduled_prompt_delivery', side_effect=crash):
        with pytest.raises(RuntimeError):
            send()
    assert events == ['text']
    assert send()['outcome'] == 'sent'
    assert events == ['text', 'audio']
    assert [row['message_id'] for row in rows(store)] == ['text-1', 'audio-1']


@pytest.mark.parametrize('missing_receipt', [False, True])
def test_ambiguous_audio_keeps_text_receipt_and_never_replays(delivery, missing_receipt):
    store, prefs, events, text, tts, audio, send = delivery
    audio.side_effect = None if missing_receipt else TimeoutError('synthetic lost response')
    audio.return_value = None
    assert send()['outcome'] == 'delivery_unknown'
    assert [row['state'] for row in rows(store)] == ['sent', 'delivery_unknown']
    assert send()['outcome'] == 'delivery_unknown'
    assert text.call_count == audio.call_count == tts.call_count == 1


@pytest.mark.parametrize('reason', ['no_audio', 'rejected', 'conversion'])
def test_optional_audio_absence_does_not_lose_text_or_repeat_synthesis(delivery, reason):
    store, prefs, events, text, tts, audio, send = delivery
    if reason == 'no_audio':
        tts.return_value = None
    else:
        audio.side_effect = (dispatch.TelegramDefiniteRejection('synthetic rejection')
            if reason == 'rejected' else dispatch.TelegramAudioError('synthetic conversion'))
    assert send()['outcome'] == 'sent'
    assert [row['state'] for row in rows(store)] == ['sent', 'skipped']
    assert send()['outcome'] == 'sent'
    assert text.call_count == tts.call_count == 1


def test_master_off_and_intentional_silence_keep_audio_off(delivery):
    store, prefs, events, text, tts, audio, send = delivery
    prefs['voice_responses_enabled'] = False
    assert send()['telegram_message_ids'] == ['text-1']
    assert events == ['text']
    tts.assert_not_called()
    assert send('{NTA}')['outcome'] == 'suppressed'
    assert events == ['text']


def test_legacy_receipt_does_not_replay_or_attach_another_audio(delivery):
    store, prefs, events, text, tts, audio, send = delivery
    old = store.claim_scheduled_prompt_delivery(run_id='synthetic-run', occurrence_key=None,
        channel='telegram', part_index=0, payload_hash='legacy-presentation-hash',
        lease_owner='original', now='2026-10-30T12:30:00Z', lease_seconds=30)
    store.complete_scheduled_prompt_delivery(delivery_key=old['delivery_key'], lease_owner='original',
        message_id='legacy-audio-1', now='2026-10-30T12:30:01Z')
    assert send()['telegram_message_ids'] == ['legacy-audio-1']
    assert events == []
    tts.assert_not_called()


def test_model_controls_keep_semantic_bubbles_and_skip_audio(delivery):
    store, prefs, events, text, tts, audio, send = delivery
    result = send('First beat.\n{MSG_BREAK}\nSecond beat.\n{SKIP_VOICE}')
    assert result['outcome'] == 'sent'
    assert [call.args[1] for call in text.call_args_list] == ['First beat.', 'Second beat.']
    assert events == ['text', 'text']
    tts.assert_not_called()


def test_voice_preference_change_does_not_drop_an_existing_audio_receipt(delivery):
    store, prefs, events, text, tts, audio, send = delivery
    first = send()
    prefs['voice_responses_enabled'] = False
    assert send()['telegram_message_ids'] == first['telegram_message_ids']
    assert events == ['text', 'audio']
    assert tts.call_count == 1


def test_master_off_cannot_hide_an_ambiguous_previous_audio_send(delivery):
    store, prefs, events, text, tts, audio, send = delivery
    audio.side_effect = TimeoutError('synthetic lost response')
    assert send()['outcome'] == 'delivery_unknown'
    prefs['voice_responses_enabled'] = False
    assert send()['outcome'] == 'delivery_unknown'
    assert text.call_count == audio.call_count == 1


def test_legacy_chunk_boundaries_are_not_reinterpreted_as_new_semantic_bubbles(delivery):
    store, prefs, events, text, tts, audio, send = delivery
    for index in range(2):
        old = store.claim_scheduled_prompt_delivery(run_id='synthetic-run', occurrence_key=None,
            channel='telegram', part_index=index, payload_hash='legacy-presentation-hash',
            lease_owner='original', now='2026-10-30T12:30:00Z', lease_seconds=30)
        store.complete_scheduled_prompt_delivery(delivery_key=old['delivery_key'], lease_owner='original',
            message_id=f'legacy-audio-{index}', now='2026-10-30T12:30:01Z')
    result = send('First beat.\n{MSG_BREAK}\nSecond beat.')
    assert result['telegram_message_ids'] == ['legacy-audio-0', 'legacy-audio-1']
    assert result['outcome'] == 'sent'
    assert events == []
    tts.assert_not_called()
