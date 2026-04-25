# === VIVENTIUM START ===
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# === VIVENTIUM END ===

import os
import sys
import unittest
from io import BytesIO
from urllib.error import HTTPError
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex import dispatch


class DispatchTelegramTests(unittest.TestCase):
    def setUp(self):
        os.environ['SCHEDULER_LIBRECHAT_SECRET'] = 'scheduler_secret'
        os.environ['SCHEDULER_TELEGRAM_SECRET'] = 'telegram_secret'
        os.environ['SCHEDULER_TELEGRAM_BOT_TOKEN'] = 'bot_token'

    def tearDown(self):
        os.environ.pop('SCHEDULER_LIBRECHAT_SECRET', None)
        os.environ.pop('SCHEDULER_TELEGRAM_SECRET', None)
        os.environ.pop('SCHEDULER_TELEGRAM_BOT_TOKEN', None)
        os.environ.pop('SCHEDULER_PROMPT_PREFIX', None)
        os.environ.pop('SCHEDULER_TELEGRAM_INSIGHT_FALLBACK', None)
        os.environ.pop('VIVENTIUM_TELEGRAM_INSIGHT_FALLBACK', None)
        os.environ.pop('SCHEDULER_FOLLOWUP_TIMEOUT_S', None)
        os.environ.pop('SCHEDULER_FOLLOWUP_TOTAL_WAIT_S', None)
        os.environ.pop('SCHEDULER_FOLLOWUP_ACTIVE_GRACE_S', None)
        os.environ.pop('SCHEDULER_TELEGRAM_FOLLOWUP_TIMEOUT_S', None)
        os.environ.pop('SCHEDULER_TELEGRAM_FOLLOWUP_GRACE_S', None)
        os.environ.pop('VIVENTIUM_TELEGRAM_FOLLOWUP_TIMEOUT_S', None)
        os.environ.pop('VIVENTIUM_TELEGRAM_FOLLOWUP_GRACE_S', None)

    def test_resolve_telegram_identity_uses_metadata(self):
        task = {
            'user_id': 'user_1',
            'metadata': {
                'telegram_user_id': 'tg-1',
                'telegram_chat_id': 'chat-1',
            },
        }
        with patch.object(dispatch, '_post_json') as mock_post:
            user_id, chat_id, voice_preferences = dispatch._resolve_telegram_identity(
                task,
                'http://localhost:3080',
                10,
            )
            mock_post.assert_not_called()
            self.assertEqual(user_id, 'tg-1')
            self.assertEqual(chat_id, 'chat-1')
            self.assertFalse(voice_preferences['always_voice_response'])
            self.assertTrue(voice_preferences['voice_responses_enabled'])

    def test_resolve_telegram_identity_calls_scheduler(self):
        task = {'user_id': 'user_1', 'metadata': None}

        def fake_post(url, payload, headers, timeout_s):
            self.assertIn('/api/viventium/scheduler/telegram/resolve', url)
            self.assertEqual(payload.get('userId'), 'user_1')
            return {
                'telegram_user_id': 'tg-2',
                'telegram_chat_id': 'tg-2',
                'voice_preferences': {
                    'always_voice_response': True,
                    'voice_responses_enabled': True,
                },
            }

        with patch.object(dispatch, '_post_json', side_effect=fake_post):
            user_id, chat_id, voice_preferences = dispatch._resolve_telegram_identity(
                task,
                'http://localhost:3080',
                10,
            )
            self.assertEqual(user_id, 'tg-2')
            self.assertEqual(chat_id, 'tg-2')
            self.assertTrue(voice_preferences['always_voice_response'])
            self.assertTrue(voice_preferences['voice_responses_enabled'])

    # === VIVENTIUM NOTE ===
    # Feature: Inject configurable prefix for scheduled prompts.
    def test_compose_prompt_injects_prefix(self):
        os.environ['SCHEDULER_PROMPT_PREFIX'] = (
            '<!--viv_internal:brew_begin-->\n'
            '## Background Processing (Brewing)\n'
            "You're seeing a scheduled self-prompt (not user input). "
            'Treat it like you just remembered something or something just came to you from yourself.'
        )
        task = {'prompt': 'Take vitamin C'}
        composed = dispatch._compose_prompt(task)
        self.assertIn('Background Processing (Brewing)', composed)
        self.assertIn('scheduled self-prompt', composed)
        self.assertIn('Take vitamin C', composed)
        self.assertTrue(composed.startswith('<!--viv_internal:brew_begin-->'))
    # === VIVENTIUM NOTE ===

    def test_compose_prompt_uses_default_prefix_when_env_missing(self):
        task = {'prompt': 'Take vitamin C'}
        composed = dispatch._compose_prompt(task)
        self.assertIn('Background Processing (Brewing)', composed)
        self.assertIn('scheduled self-prompt', composed)
        self.assertIn('Take vitamin C', composed)
        self.assertTrue(composed.startswith('<!--viv_internal:brew_begin-->'))

    def test_compose_prompt_does_not_double_prefix_existing_scheduled_prompt(self):
        existing = (
            '<!--viv_internal:brew_begin-->\n'
            '## Background Processing (Brewing)\n'
            'This is a scheduled self-prompt.\n\n'
            'Take vitamin C'
        )
        task = {'prompt': existing}
        composed = dispatch._compose_prompt(task)
        self.assertEqual(composed, existing)

    def test_dispatch_task_sends_telegram_message(self):
        task = {
            'id': 'task-1',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-1',
                'final_text': 'final response',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-3', 'tg-3', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_called_once()
            args, _kwargs = mock_send.call_args
            self.assertEqual(args[0], 'tg-3')
            self.assertEqual(args[1], 'final response')
            self.assertEqual(result.get('conversation_id'), 'new')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), 'final response')
        # === VIVENTIUM NOTE ===

    def test_format_insight_fallback_is_human_like(self):
        insights = [
            {'cortex_name': 'Online Tool Use', 'insight': 'First insight.'},
            {'cortex_name': 'Pattern Recognition', 'insight': 'Second insight.'},
        ]
        text = dispatch._format_insight_fallback(insights)
        self.assertIn('First insight.', text)
        self.assertIn('Second insight.', text)
        self.assertNotIn('Background insights', text)
        self.assertNotIn('Online Tool Use', text)
        self.assertNotIn('Pattern Recognition', text)

    # === VIVENTIUM NOTE ===
    # Feature: Ensure scheduled Telegram dispatch sends background follow-ups.
    def test_dispatch_task_sends_followup_from_stream(self):
        task = {
            'id': 'task-2',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-2',
                'final_text': 'final response',
                'followup_text': 'follow-up',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-4', 'tg-4', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            self.assertEqual(mock_send.call_count, 2)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'final response')
            self.assertEqual(mock_send.call_args_list[1].args[1], 'follow-up')
            self.assertEqual(result.get('conversation_id'), 'new')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), 'final response')

    def test_post_json_surfaces_scheduler_auth_reason(self):
        error = HTTPError(
            url='http://localhost:3080/api/viventium/scheduler/chat',
            code=401,
            msg='Unauthorized',
            hdrs=None,
            fp=BytesIO(b'{"error":"Unauthorized scheduler gateway","reason":"secret_mismatch"}'),
        )

        with patch('urllib.request.urlopen', side_effect=error):
            with self.assertRaisesRegex(
                RuntimeError,
                r'HTTP 401 \(secret_mismatch\): Unauthorized scheduler gateway',
            ):
                dispatch._post_json(
                    'http://localhost:3080/api/viventium/scheduler/chat',
                    {'userId': 'user_1'},
                    {'x-viventium-scheduler-secret': 'bad'},
                    10,
                )

    def test_run_scheduler_generation_promotes_canonical_parent_text(self):
        task = {
            'id': 'task-canonical',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'librechat',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-canonical', 'conversationId': 'conv-canonical'},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('{NTA}', 'msg-canonical', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': 'Fresh canonical summary'},
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(result.get('conversation_id'), 'conv-canonical')
            self.assertEqual(result.get('response_message_id'), 'msg-canonical')
            self.assertEqual(result.get('final_text'), 'Fresh canonical summary')
            self.assertEqual(result.get('final_text_source'), 'canonical_parent')
            self.assertEqual(result.get('followup_text'), '')

    def test_run_scheduler_generation_marks_promoted_deferred_fallback_source(self):
        task = {
            'id': 'task-canonical-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-canonical-fallback', 'conversationId': 'conv-canonical-fallback'},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('{NTA}', 'msg-canonical-fallback', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={
                'followup_text': '',
                'canonical_text': 'Best-effort fallback summary',
                'canonical_text_source': 'deferred_fallback',
                'canonical_text_fallback_reason': 'insight_fallback',
            },
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(result.get('final_text'), 'Best-effort fallback summary')
            self.assertEqual(result.get('final_text_source'), 'deferred_fallback')
            self.assertEqual(result.get('final_text_fallback_reason'), 'insight_fallback')

    def test_run_scheduler_generation_preserves_empty_scheduled_fallback_reason(self):
        task = {
            'id': 'task-empty-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-empty-fallback', 'conversationId': 'conv-empty-fallback'},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('{NTA}', 'msg-empty-fallback', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={
                'followup_text': '',
                'canonical_text': '',
                'canonical_text_source': 'deferred_fallback',
                'canonical_text_fallback_reason': 'empty_deferred_response',
            },
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(result.get('final_text'), '{NTA}')
            self.assertEqual(result.get('suppressed_fallback_reason'), 'empty_deferred_response')

    def test_run_scheduler_generation_dedupes_matching_followup_text(self):
        task = {
            'id': 'task-canonical-dedupe',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'librechat',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-canonical-dedupe', 'conversationId': 'conv-canonical-dedupe'},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('{NTA}', 'msg-canonical-dedupe', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={
                'followup_text': 'Fresh canonical summary',
                'canonical_text': 'Fresh canonical summary',
            },
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(result.get('final_text'), 'Fresh canonical summary')
            self.assertEqual(result.get('followup_text'), '')

    def test_scheduler_followup_poll_uses_telegram_parity_settings_for_telegram_tasks(self):
        task = {
            'id': 'task-followup-telegram',
            'channel': ['telegram', 'librechat'],
        }

        with patch.object(
            dispatch,
            '_poll_followup_state',
            return_value={'followup_text': '', 'canonical_text': ''},
        ) as mock_poll:
            dispatch._poll_scheduler_followup(
                task,
                'http://localhost:3080',
                'msg-telegram',
                'user-1',
                'conv-1',
                'scheduler_secret',
                10,
            )

        kwargs = mock_poll.call_args.kwargs
        self.assertEqual(kwargs['timeout_s'], 210.0)
        self.assertEqual(kwargs['grace_s'], 8.0)
        self.assertFalse(kwargs['allow_insight_fallback'])
        self.assertIn('scheduleId=task-followup-telegram', kwargs['url'])

    def test_scheduler_followup_poll_uses_short_defaults_without_telegram(self):
        task = {
            'id': 'task-followup-librechat',
            'channel': ['librechat'],
        }

        with patch.object(
            dispatch,
            '_poll_followup_state',
            return_value={'followup_text': '', 'canonical_text': ''},
        ) as mock_poll:
            dispatch._poll_scheduler_followup(
                task,
                'http://localhost:3080',
                'msg-librechat',
                'user-1',
                'conv-1',
                'scheduler_secret',
                10,
            )

        kwargs = mock_poll.call_args.kwargs
        self.assertEqual(kwargs['timeout_s'], 18.0)
        self.assertEqual(kwargs['grace_s'], 18.0)
        self.assertFalse(kwargs['allow_insight_fallback'])

    def test_scheduler_followup_poll_allows_opt_in_insight_fallback_for_telegram_tasks(self):
        os.environ['SCHEDULER_TELEGRAM_INSIGHT_FALLBACK'] = '1'
        task = {
            'id': 'task-followup-fallback',
            'channel': ['telegram'],
        }

        with patch.object(
            dispatch,
            '_poll_followup_state',
            return_value={'followup_text': '', 'canonical_text': ''},
        ) as mock_poll:
            dispatch._poll_scheduler_followup(
                task,
                'http://localhost:3080',
                'msg-telegram',
                'user-1',
                'conv-1',
                'scheduler_secret',
                10,
            )

        kwargs = mock_poll.call_args.kwargs
        self.assertTrue(kwargs['allow_insight_fallback'])

    def test_poll_followup_state_preserves_canonical_fallback_provenance(self):
        with patch.object(
            dispatch,
            '_get_json',
            return_value={
                'canonicalText': '',
                'canonicalTextSource': 'deferred_fallback',
                'canonicalTextFallbackReason': 'empty_deferred_response',
                'followUp': None,
                'cortexParts': [],
            },
        ):
            result = dispatch._poll_followup_state(
                url='http://localhost:3080/api/viventium/scheduler/cortex/msg-1',
                headers={},
                http_timeout_s=1,
                interval_s=0.01,
                grace_s=0,
                timeout_s=0.01,
                allow_insight_fallback=False,
                warning_prefix='Scheduler',
            )

        self.assertEqual(result.get('canonical_text'), '')
        self.assertEqual(result.get('canonical_text_source'), 'deferred_fallback')
        self.assertEqual(result.get('canonical_text_fallback_reason'), 'empty_deferred_response')

    def test_dispatch_task_defaults_to_all_channels(self):
        task = {
            'id': 'task-4',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': None,
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-1',
                'response_message_id': 'msg-4',
                'final_text': 'hello there',
                'followup_text': '',
            },
        ) as mock_run, patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            return_value={'outcome': 'sent', 'reason': 'delivered', 'generated_text': 'hello there'},
        ) as mock_tg:
            result = dispatch.dispatch_task(task)

            self.assertEqual(mock_run.call_count, 1)
            self.assertEqual(mock_tg.call_count, 1)
            self.assertEqual(result.get('conversation_id'), 'lc-1')

    def test_dispatch_task_fan_out_for_channel_list(self):
        task = {
            'id': 'task-5',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': ['telegram', 'librechat'],
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-2',
                'response_message_id': 'msg-5',
                'final_text': 'hello there',
                'followup_text': '',
            },
        ) as mock_run, patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            return_value={'outcome': 'sent', 'reason': 'delivered', 'generated_text': 'hello there'},
        ) as mock_tg:
            result = dispatch.dispatch_task(task)

            self.assertEqual(mock_run.call_count, 1)
            self.assertEqual(mock_tg.call_count, 1)
            self.assertIn('channel_results', result)
            self.assertIn('telegram', result.get('channel_results', {}))
            self.assertIn('librechat', result.get('channel_results', {}))
            self.assertEqual(result.get('conversation_id'), 'lc-2')
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Ensure scheduled Telegram Markdown is rendered safely.
    def test_render_telegram_markdown_converts_basic_markdown(self):
        text = "**Bold**\n- item\n`code`"
        rendered = dispatch.render_telegram_markdown(text)
        self.assertIn("<b>Bold</b>", rendered)
        self.assertIn("• item", rendered)
        self.assertIn("<code>code</code>", rendered)

    def test_render_telegram_markdown_inbox_sample(self):
        text = "**Daily Inbox Check**  \n*America/Toronto, ~7AM*  \n\n**Recent Activity**"
        rendered = dispatch.render_telegram_markdown(text)
        self.assertNotIn("**", rendered)
        self.assertIn("<b>Daily Inbox Check</b>", rendered)

    def test_send_telegram_message_fallbacks_to_plain_text(self):
        payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            payloads.append(dict(payload))
            if len(payloads) == 1:
                raise RuntimeError("parse entities")
            return {}

        with patch.object(dispatch, '_post_json', side_effect=fake_post):
            dispatch._send_telegram_message('tg-1', '**Bold**', 10)

        self.assertEqual(payloads[0].get('parse_mode'), 'HTML')
        self.assertNotIn('parse_mode', payloads[1])
        self.assertNotIn('<b>', payloads[1].get('text', ''))
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Telegram ok=false should trigger plain-text fallback.
    def test_send_telegram_message_fallbacks_on_ok_false(self):
        payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            payloads.append(dict(payload))
            if len(payloads) == 1:
                return {"ok": False, "description": "Bad Request: can't parse entities"}
            return {"ok": True}

        with patch.object(dispatch, '_post_json', side_effect=fake_post):
            dispatch._send_telegram_message('tg-1', '**Bold**', 10)

        self.assertEqual(payloads[0].get('parse_mode'), 'HTML')
        self.assertNotIn('parse_mode', payloads[1])
        self.assertNotIn('<b>', payloads[1].get('text', ''))
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Scheduler Telegram path must strip internal recall/tool artifacts.
    def test_sanitize_telegram_text_strips_internal_surface_artifacts(self):
        text = """
<turn timestamp="2026-02-24T13:30:03.504Z" role="user">what should be my priority</turn>
<turn timestamp="2026-02-24T13:30:36.704Z" role="AI">Passport renewal's on for Thursday.</turn>

─────────────────
Tool: file_search, File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt
Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)
Relevance: 1.0967
Content: <turn timestamp="2026-02-22T23:19:11.562Z" role="AI">Archived text</turn>
"""
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertIn("Passport renewal's on for Thursday.", cleaned)
        self.assertNotIn("what should be my priority", cleaned)
        self.assertNotIn("Tool:", cleaned)
        self.assertNotIn("File:", cleaned)
        self.assertNotIn("Anchor:", cleaned)
        self.assertNotIn("Relevance:", cleaned)
        self.assertNotIn("<turn", cleaned)

    def test_send_telegram_message_strips_internal_surface_artifacts(self):
        payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            payloads.append(dict(payload))
            return {"ok": True}

        text = """
Tool: file_search, File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt
Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)
Relevance: 1.1568
Content: <turn timestamp="2026-02-25T00:00:06.441Z" role="AI">Archived text</turn>
"""
        with patch.object(dispatch, '_post_json', side_effect=fake_post):
            dispatch._send_telegram_message('tg-1', text, 10)

        self.assertEqual(len(payloads), 1)
        sent_text = payloads[0].get('text', '')
        self.assertNotIn('Tool:', sent_text)
        self.assertNotIn('Anchor:', sent_text)
        self.assertNotIn('Relevance:', sent_text)
        self.assertNotIn('<turn', sent_text)

    def test_sanitize_strips_real_heartbeat_leak(self):
        """Regression: exact artifact pattern that leaked in a previous heartbeat run."""
        text = (
            "Flights are locked, team. Momentum is real now. "
            "Correction: The application path is the actual legal thread.\n\n"
            "─────────────────\n"
            "File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt\n"
            "Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)\n"
            "Relevance: 0.4496\n"
            "Content: Less granular neighbourhood filtering. Reviews less reliable.\n\n"
            "─────────────────\n"
            "Tool: file_search, File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt\n"
            "Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)\n"
            "Relevance: 1.1568\n"
            'Content: <turn timestamp="2026-02-25T00:00:06.441Z" '
            'conversation="f64e64ca-ee18-412a-8ce0-9d13754b979b" role="AI">\n'
            "Post-Gym Protocol SF Housing: Post-gym, hit Airbnb for Potrero Hill\n"
            "</turn>\n\n"
            "─────────────────\n"
            "File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt\n"
            "Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)\n"
            "Relevance: 0.9082\n"
            "Content: 100% not going to mission its infested with poop\n\n"
            "─────────────────\n"
        )
        cleaned = dispatch._sanitize_telegram_text(text)
        # Model response preserved
        self.assertIn("Flights are locked, team", cleaned)
        self.assertIn("application path", cleaned)
        # All recall artifacts stripped
        self.assertNotIn("Tool:", cleaned)
        self.assertNotIn("File:", cleaned)
        self.assertNotIn("Anchor:", cleaned)
        self.assertNotIn("Relevance:", cleaned)
        self.assertNotIn("Content:", cleaned)
        self.assertNotIn("<turn", cleaned)
        self.assertNotIn("</turn>", cleaned)
        self.assertNotIn("conversation-recall", cleaned)
        self.assertNotIn("infested with poop", cleaned)
        # Preserved assistant turn content (if any) is clean
        self.assertNotIn("Post-Gym Protocol", cleaned)

    def test_sanitize_strips_consecutive_recall_blocks_with_mixed_separators(self):
        """Multiple recall blocks with varied separator patterns all get stripped."""
        text = (
            "Here is a clean response.\n\n"
            "Tool: file_search, File: recall-file.txt\n"
            "Anchor: (recall-file.txt)\n"
            "Relevance: 0.8\n"
            "Content: Some archived content\n\n"
            "─────────────────\n"
            "File: another-file.txt\n"
            "Anchor: (another-file.txt)\n"
            "Relevance: 0.6\n"
            "Content: More archived stuff\n"
        )
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertIn("Here is a clean response", cleaned)
        self.assertNotIn("file_search", cleaned)
        self.assertNotIn("Anchor:", cleaned)
        self.assertNotIn("archived", cleaned)

    def test_sanitize_strips_tool_error_line_variant(self):
        text = "Tool: file_search, File search encountered errors or timed out. Please try again or rephrase your query."
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertEqual(cleaned, "")

    def test_sanitize_keeps_text_while_stripping_tool_error_line(self):
        text = (
            "Quick pulse.\n"
            "Tool: file_search, File search encountered errors or timed out. Please try again or rephrase your query.\n"
            "Stay focused."
        )
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertIn("Quick pulse.", cleaned)
        self.assertIn("Stay focused.", cleaned)
        self.assertNotIn("Tool:", cleaned)
        self.assertNotIn("file_search", cleaned)

    def test_sanitize_strips_markdownv2_backslash_escapes(self):
        """Regression: models sometimes emit MarkdownV2 escapes that leak as literal backslashes."""
        text = (
            "You two look class\\. Heading to get roasted, then? "
            "Avery's glasses are a proper vibe\\. "
            "Hope the TTC isn't too much of a buzzkill after that Rumble energy earlier\\. "
            "Enjoy being the best\\-looking founders in the room\\. 🎤🏙️🥂"
        )
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertNotIn("\\.", cleaned)
        self.assertNotIn("\\-", cleaned)
        self.assertIn("class.", cleaned)
        self.assertIn("vibe.", cleaned)
        self.assertIn("best-looking", cleaned)
        self.assertIn("room.", cleaned)
        self.assertIn("🎤🏙️🥂", cleaned)

    def test_sanitize_strips_mixed_markdownv2_escapes(self):
        """MarkdownV2 escapes all 17 special chars — verify we strip them all."""
        text = "Test\\! with\\# many\\.escaped\\- chars\\= and\\| pipes\\{curly\\}"
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertNotIn("\\!", cleaned)
        self.assertNotIn("\\#", cleaned)
        self.assertNotIn("\\.", cleaned)
        self.assertNotIn("\\-", cleaned)
        self.assertNotIn("\\=", cleaned)
        self.assertNotIn("\\|", cleaned)
        self.assertNotIn("\\{", cleaned)
        self.assertNotIn("\\}", cleaned)
        self.assertIn("Test!", cleaned)
        self.assertIn("with#", cleaned)
        self.assertIn("many.escaped-", cleaned)

    def test_render_telegram_markdown_unescapes_markdownv2(self):
        """End-to-end: MarkdownV2 escapes in model output should not appear in rendered HTML."""
        text = "Great vibe\\. Best\\-looking spot in town\\!"
        rendered = dispatch.render_telegram_markdown(text)
        self.assertNotIn("\\.", rendered)
        self.assertNotIn("\\-", rendered)
        self.assertNotIn("\\!", rendered)
        self.assertIn("vibe.", rendered)
        self.assertIn("Best-looking", rendered)
        # Should be valid HTML output
        self.assertNotIn("\\", rendered)
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Empty/whitespace final_text treated as intentional silence (no placeholder).
    def test_dispatch_telegram_suppresses_empty_final_text(self):
        """Empty final_text should not produce '(No response generated.)' — it should be silent."""
        task = {
            'id': 'task-empty',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-e',
                'final_text': '',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-e', 'tg-e', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('conversation_id'), 'new')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty')

    def test_dispatch_telegram_suppresses_whitespace_final_text(self):
        """Whitespace-only final_text should be treated as silence."""
        task = {
            'id': 'task-ws',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-ws',
                'final_text': '   \n  ',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-ws', 'tg-ws', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty')

    def test_dispatch_telegram_marks_visible_deferred_fallback_as_degraded(self):
        task = {
            'id': 'task-visible-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-visible-fallback',
                'final_text': 'Best-effort fallback summary',
                'followup_text': '',
                'final_text_source': 'deferred_fallback',
                'final_text_fallback_reason': 'insight_fallback',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-fallback', 'tg-fallback', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_called_once()
            self.assertEqual(mock_send.call_args.args[1], 'Best-effort fallback summary')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'fallback_delivered')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:insight_fallback')
            telegram_delivery = result.get('delivery', {}).get('channels', {}).get('telegram', {})
            self.assertTrue(telegram_delivery.get('fallback_delivered'))

    def test_dispatch_telegram_suppresses_empty_scheduled_deferred_fallback(self):
        task = {
            'id': 'task-empty-scheduled-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-empty-scheduled-fallback',
                'final_text': '{NTA}',
                'followup_text': '',
                'suppressed_fallback_reason': 'empty_deferred_response',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-empty-fallback', 'tg-empty-fallback', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty_deferred_response')

    def test_dispatch_telegram_suppresses_nta_final_text(self):
        """NTA final_text should be suppressed (existing behavior, regression guard)."""
        task = {
            'id': 'task-nta',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-nta',
                'final_text': '{NTA}',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-nta', 'tg-nta', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:nta')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), '{NTA}')
            self.assertEqual(
                result.get('delivery', {}).get('channels', {}).get('telegram', {}).get('final_generated_text'),
                '{NTA}',
            )

    def test_dispatch_telegram_suppresses_artifact_only_final_text(self):
        """Artifact-only final_text should be treated as empty after sanitization."""
        task = {
            'id': 'task-artifact',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        artifact = (
            "Tool: file_search, File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt\n"
            "Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)\n"
            "Relevance: 1.1568\n"
            "Content: <turn timestamp=\"2026-02-25T00:00:06.441Z\" role=\"AI\">Archived text</turn>"
        )

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-art',
                'final_text': artifact,
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-art', 'tg-art', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty')
            self.assertIsNone(result.get('delivery', {}).get('generated_text'))
            self.assertIsNone(
                result.get('delivery', {}).get('channels', {}).get('telegram', {}).get('final_generated_text'),
            )

    def test_dispatch_telegram_suppresses_tool_error_only_final_text(self):
        """Tool-surface error lines must not be sent to Telegram."""
        task = {
            'id': 'task-tool-error',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        tool_error = "Tool: file_search, File search encountered errors or timed out. Please try again or rephrase your query."

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-tool',
                'final_text': tool_error,
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-tool', 'tg-tool', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty')
            self.assertIsNone(result.get('delivery', {}).get('generated_text'))

    def test_dispatch_telegram_heartbeat_keepalive_after_repeated_nta(self):
        """Heartbeat tasks should send a concise keepalive after repeated NTA suppressions."""
        task = {
            'id': 'task-heartbeat',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'heartbeat',
            'channel': 'telegram',
            'conversation_policy': 'same',
            'next_run_at': '2026-02-13T20:00:00Z',
            'schedule': {'type': 'cron', 'cron': '*/30 9-21 * * *', 'timezone': 'America/Toronto'},
            'metadata': {'name': 'Heartbeat', 'heartbeat_quiet_streak': 2},
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'conv-hb',
                'response_message_id': 'msg-hb',
                'final_text': '{NTA}',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-hb', 'tg-hb', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            self.assertEqual(mock_send.call_count, 1)
            keepalive_text = mock_send.call_args_list[0].args[1]
            self.assertIn("Quick pulse:", keepalive_text)
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'heartbeat_keepalive')
            self.assertEqual(
                result.get('delivery', {}).get('channels', {}).get('telegram', {}).get('sent_followup'),
                True,
            )

    def test_dispatch_telegram_still_sends_followup_when_final_suppressed(self):
        """Even when final_text is suppressed, a non-empty follow-up should still deliver."""
        task = {
            'id': 'task-fu',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-fu',
                'final_text': '{NTA}',
                'followup_text': 'Here are your insights...',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-fu', 'tg-fu', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            # Only the follow-up should be sent, not the NTA final
            self.assertEqual(mock_send.call_count, 1)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'Here are your insights...')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), 'Here are your insights...')

    def test_dispatch_telegram_uses_canonical_parent_text_when_initial_final_suppressed(self):
        task = {
            'id': 'task-canonical-tg',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-canonical', 'tg-canonical', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-tg-canonical', 'conversationId': 'conv-tg-canonical'},
        ), patch.object(
            dispatch,
            '_stream_telegram_response',
            return_value=('{NTA}', 'msg-tg-canonical', ''),
        ), patch.object(
            dispatch,
            '_poll_telegram_followup',
            return_value={'followup_text': '', 'canonical_text': 'Inbox summary from canonical parent'},
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch._dispatch_telegram(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(mock_send.call_count, 1)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'Inbox summary from canonical parent')
            self.assertEqual(result.get('conversation_id'), 'conv-tg-canonical')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), 'Inbox summary from canonical parent')
            self.assertEqual(result.get('delivery', {}).get('final_generated_text'), 'Inbox summary from canonical parent')
            self.assertTrue(result.get('delivery', {}).get('sent_final'))

    def test_legacy_dispatch_telegram_marks_visible_deferred_fallback_as_degraded(self):
        task = {
            'id': 'task-legacy-visible-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-legacy-fallback', 'tg-legacy-fallback', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-legacy-fallback', 'conversationId': 'conv-legacy-fallback'},
        ), patch.object(
            dispatch,
            '_stream_telegram_response',
            return_value=('{NTA}', 'msg-legacy-fallback', ''),
        ), patch.object(
            dispatch,
            '_poll_telegram_followup',
            return_value={
                'followup_text': '',
                'canonical_text': 'Best-effort fallback summary',
                'canonical_text_source': 'deferred_fallback',
                'canonical_text_fallback_reason': 'insight_fallback',
            },
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch._dispatch_telegram(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(mock_send.call_count, 1)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'Best-effort fallback summary')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'fallback_delivered')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'insight_fallback')
            self.assertTrue(result.get('delivery', {}).get('fallback_delivered'))

    def test_legacy_dispatch_telegram_suppresses_empty_scheduled_deferred_fallback(self):
        task = {
            'id': 'task-legacy-empty-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-legacy-empty', 'tg-legacy-empty', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-legacy-empty', 'conversationId': 'conv-legacy-empty'},
        ), patch.object(
            dispatch,
            '_stream_telegram_response',
            return_value=('{NTA}', 'msg-legacy-empty', ''),
        ), patch.object(
            dispatch,
            '_poll_telegram_followup',
            return_value={
                'followup_text': '',
                'canonical_text': '',
                'canonical_text_source': 'deferred_fallback',
                'canonical_text_fallback_reason': 'empty_deferred_response',
            },
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch._dispatch_telegram(task, 'http://localhost:3080', 10, 'new')

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'empty_deferred_response')
            self.assertFalse(result.get('delivery', {}).get('fallback_delivered'))

    def test_dispatch_telegram_dedupes_matching_followup_text(self):
        task = {
            'id': 'task-canonical-tg-dedupe',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-canonical', 'tg-canonical', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-tg-dedupe', 'conversationId': 'conv-tg-dedupe'},
        ), patch.object(
            dispatch,
            '_stream_telegram_response',
            return_value=('{NTA}', 'msg-tg-dedupe', ''),
        ), patch.object(
            dispatch,
            '_poll_telegram_followup',
            return_value={
                'followup_text': 'Inbox summary from canonical parent',
                'canonical_text': 'Inbox summary from canonical parent',
            },
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch._dispatch_telegram(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(mock_send.call_count, 1)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'Inbox summary from canonical parent')
            self.assertEqual(result.get('delivery', {}).get('followup_generated_text'), None)
            self.assertFalse(result.get('delivery', {}).get('sent_followup'))
    # === VIVENTIUM NOTE ===


class DispatchBestEffortFanoutTests(unittest.TestCase):
    """Tests for best-effort multi-channel dispatch (partial success semantics)."""

    def setUp(self):
        os.environ['SCHEDULER_LIBRECHAT_SECRET'] = 'scheduler_secret'
        os.environ['SCHEDULER_TELEGRAM_SECRET'] = 'telegram_secret'
        os.environ['SCHEDULER_TELEGRAM_BOT_TOKEN'] = 'bot_token'

    def tearDown(self):
        os.environ.pop('SCHEDULER_LIBRECHAT_SECRET', None)
        os.environ.pop('SCHEDULER_TELEGRAM_SECRET', None)
        os.environ.pop('SCHEDULER_TELEGRAM_BOT_TOKEN', None)

    def test_partial_success_telegram_fails_librechat_succeeds(self):
        task = {
            'id': 'task-partial-1',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'morning briefing',
            'channel': ['librechat', 'telegram'],
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-ok',
                'response_message_id': 'msg-partial-1',
                'final_text': 'Good morning!',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            side_effect=RuntimeError('Telegram identity not found'),
        ):
            result = dispatch.dispatch_task(task)

            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertIn('channel_errors', result)
            self.assertIn('telegram', result['channel_errors'])
            self.assertIn('identity', result['channel_errors']['telegram'])

    def test_generation_failure_raises_runtime_error(self):
        task = {
            'id': 'task-generate-fail',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'morning briefing',
            'channel': ['telegram'],
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(dispatch, '_run_scheduler_generation', side_effect=RuntimeError('scheduler down')):
            with self.assertRaises(RuntimeError) as ctx:
                dispatch.dispatch_task(task)
            self.assertIn('scheduler down', str(ctx.exception).lower())

    def test_single_channel_success_no_channel_errors_key(self):
        task = {
            'id': 'task-clean',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'librechat',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-clean',
                'response_message_id': 'msg-clean',
                'final_text': 'Hi',
                'followup_text': '',
            },
        ):
            result = dispatch.dispatch_task(task)

            self.assertNotIn('channel_errors', result)
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')


if __name__ == '__main__':
    unittest.main()
