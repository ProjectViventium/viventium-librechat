/* === VIVENTIUM START === Native owner input form; keep uncertain responses retryable until native ACK. === VIVENTIUM END === */
import { useRef, useState } from 'react';
import { Button } from '@librechat/client';
import type {
  NativeWorkInputResponse,
  PendingNativeWorkInput,
  NativeQuestionContent,
} from 'librechat-data-provider';
import { useWorkActionMutation } from '~/data-provider/ViventiumOrchestration';
import { useLocalize } from '~/hooks';

/** Render the native server's request; consent belongs to the signed-in user. */
export default function NativeWorkInput({
  workRef,
  input,
}: {
  workRef: string;
  input: PendingNativeWorkInput;
}) {
  const localize = useLocalize();
  const mutation = useWorkActionMutation();
  const [values, setValues] = useState<Record<string, string | number | boolean | string[]>>({});
  const [questionAnswers, setQuestionAnswers] = useState<NativeQuestionContent>({ answers: {} });
  const [error, setError] = useState<'invalid' | 'unconfirmed' | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const retained = useRef<{ operationId: string; nativeInput: NativeWorkInputResponse }>();
  const fields = Object.entries(
    input.kind === 'question' ? {} : (input.requestedSchema?.properties ?? {}),
  );
  const required = new Set(input.requestedSchema?.required ?? []);
  let externalUrl: string | null = null;
  try {
    const parsed = new URL(input.url ?? '');
    if (['http:', 'https:'].includes(parsed.protocol)) externalUrl = parsed.href;
  } catch {
    /* A malformed link is never opened. */
  }
  const submit = (action: NativeWorkInputResponse['action']) => {
    const operation = retained.current ?? {
      operationId: crypto.randomUUID(),
      nativeInput: {
        version: 1 as const,
        requestId: input.requestId,
        requestFingerprint: input.requestFingerprint,
        action,
        ...(action === 'accept' && input.mode === 'form'
          ? { content: input.kind === 'question' ? {answers:questionAnswers.answers,...(Object.values(questionAnswers.annotations||{}).some(value=>value.notes.length>0) ? {annotations:Object.fromEntries(Object.entries(questionAnswers.annotations||{}).filter(([,value])=>value.notes.length>0))}: {})} : values }
          : {}),
      },
    };
    retained.current = operation;
    setError(null);
    mutation.mutate(
      { workRef, action: 'resume', ...operation },
      {
        onSuccess: (result) => {
          const receipt = result as { status?: string; confirmationPending?: boolean } | null;
          const accepted =
            receipt != null &&
            ['accepted', 'already_accepted'].includes(receipt.status ?? '') &&
            receipt.confirmationPending !== true;
          setAcknowledged(accepted);
          if (!accepted) setError('unconfirmed');
        },
        onError: (failure) => {
          const status = (failure as Error & { response?: { status?: number } }).response?.status;
          if (status === 400 || status === 422) retained.current = undefined;
          setError(status === 400 || status === 422 ? 'invalid' : 'unconfirmed');
        },
      },
    );
  };
  return (
    <form
      className="mt-3 space-y-3 [overflow-wrap:anywhere]"
      aria-label={localize('com_ui_work_input_request')}
      onSubmit={(event) => {
        event.preventDefault();
        submit('accept');
      }}
    >
      <p className="whitespace-pre-wrap text-sm text-text-primary">{input.message}</p>
      <p className="text-xs text-text-secondary">
        {input.kind === 'elicitation' ? input.mcpServerName : input.runtimeName}
      </p>
      {input.mode === 'url' && externalUrl && (
        <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="underline">
          {localize('com_ui_work_input_open')}
        </a>
      )}
      {input.kind === 'question' &&
        Object.entries(input.requestedSchema.properties.answers.properties).map(([key, field]) => (
          <fieldset key={key} className="space-y-2" disabled={Boolean(retained.current)}>
            <legend>{field.title || key}</legend>
            {field.items.enum.map((option) => (
              <label key={option} className="flex gap-2">
                <input
                  type={field.maxItems === 1 ? 'radio' : 'checkbox'}
                  name={key}
                  checked={(Object.hasOwn(questionAnswers.answers,key) ? questionAnswers.answers[key]?.includes(option) : false) || false}
                  onChange={(event) =>
                    setQuestionAnswers((current) => {
                      const before = Object.hasOwn(current.answers,key) ? current.answers[key] : [];
                      const selected = event.target.checked
                        ? field.maxItems === 1
                          ? [option]
                          : [...before, option]
                        : before.filter((value) => value !== option);
                      const answers = selected.length ? {...current.answers,[key]:selected} : {...current.answers};
                      if(!selected.length) delete answers[key];
                      const annotations = { ...current.annotations };
                      if (!selected.includes('Other')) delete annotations[key];
                      return {
                        answers,
                        ...(Object.keys(annotations).length ? { annotations } : {}),
                      };
                    })
                  }
                />
                {option}
              </label>
            ))}
            {(Object.hasOwn(questionAnswers.answers,key) && questionAnswers.answers[key]?.includes('Other')) && (
              <label className="block">
                {localize('com_ui_response')}
                <input
                  aria-label={`${localize('com_ui_response')}: ${field.title || key}`}
                  maxLength={8000}
                  value={(questionAnswers.annotations && Object.hasOwn(questionAnswers.annotations,key) ? questionAnswers.annotations[key]?.notes : '') || ''}
                  onChange={(event) =>
                    setQuestionAnswers((current) => ({
                      ...current,
                      annotations: { ...current.annotations, [key]: { notes: event.target.value } },
                    }))
                  }
                />
              </label>
            )}
          </fieldset>
        ))}
      {input.mode === 'form' &&
        fields.map(([name, field]) => {
          const label = field.title || name;
          const value = Object.hasOwn(values, name) ? values[name] : undefined;
          const change = (next: string | number | boolean | string[] | undefined) =>
            setValues((current) => {
              const updated = { ...current };
              if (next === undefined) delete updated[name];
              else updated[name] = next;
              return updated;
            });
          const options =
            field.type === 'string'
              ? 'enum' in field
                ? field.enum.map((item, index) => ({
                    value: item,
                    label: ('enumNames' in field ? field.enumNames?.[index] : null) || item,
                  }))
                : 'oneOf' in field
                  ? field.oneOf.map((item) => ({ value: item.const, label: item.title }))
                  : null
              : field.type === 'array'
                ? 'enum' in field.items
                  ? field.items.enum.map((item) => ({ value: item, label: item }))
                  : field.items.anyOf.map((item) => ({ value: item.const, label: item.title }))
                : null;
          return (
            <label key={name} className="block text-sm text-text-primary">
              <span>{label}</span>
              {field.description && (
                <span className="block text-xs text-text-secondary">{field.description}</span>
              )}
              {field.type === 'boolean' ? (
                <select
                  className="mt-1 min-h-11 w-full rounded-md border border-border-light bg-surface-primary px-2"
                  aria-label={label}
                  required={required.has(name)}
                  value={value == null ? '' : String(value)}
                  disabled={Boolean(retained.current)}
                  onChange={(event) =>
                    change(event.target.value === '' ? undefined : event.target.value === 'true')
                  }
                >
                  <option value="">{localize('com_ui_work_input_choose')}</option>
                  <option value="true">{localize('com_ui_yes')}</option>
                  <option value="false">{localize('com_ui_no')}</option>
                </select>
              ) : options ? (
                <select
                  className="mt-1 min-h-11 w-full rounded-md border border-border-light bg-surface-primary px-2"
                  aria-label={label}
                  required={required.has(name)}
                  multiple={field.type === 'array'}
                  value={
                    field.type === 'array'
                      ? Array.isArray(value)
                        ? value
                        : []
                      : String(value ?? '')
                  }
                  disabled={Boolean(retained.current)}
                  onChange={(event) =>
                    change(
                      field.type === 'array'
                        ? Array.from(event.target.selectedOptions, (option) => option.value)
                        : event.target.value === '' &&
                            !options.some((option) => option.value === '')
                          ? undefined
                          : event.target.value,
                    )
                  }
                >
                  {field.type !== 'array' && (
                    <option value="">{localize('com_ui_work_input_choose')}</option>
                  )}
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={label}
                  required={required.has(name)}
                  value={String(value ?? '')}
                  disabled={Boolean(retained.current)}
                  type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
                  step={field.type === 'integer' ? 1 : 'any'}
                  min={'minimum' in field ? field.minimum : undefined}
                  max={'maximum' in field ? field.maximum : undefined}
                  minLength={'minLength' in field ? field.minLength : undefined}
                  maxLength={'maxLength' in field ? field.maxLength : undefined}
                  onChange={(event) =>
                    change(
                      field.type === 'number' || field.type === 'integer'
                        ? event.target.value === ''
                          ? undefined
                          : Number(event.target.value)
                        : event.target.value,
                    )
                  }
                  className="mt-1 min-h-11 w-full rounded-md border border-border-light bg-transparent px-2 py-1"
                />
              )}
            </label>
          );
        })}
      {error && (
        <p role="alert">
          {localize(error === 'invalid' ? 'com_ui_work_input_invalid' : 'com_ui_work_input_retry')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={
            mutation.isLoading ||
            acknowledged ||
            (input.mode === 'url' && !externalUrl) ||
            (input.kind === 'question' && !Object.keys(questionAnswers.answers).length) ||
            Boolean(retained.current && retained.current.nativeInput.action !== 'accept')
          }
        >
          {localize('com_ui_continue')}
        </Button>
        <Button
          type="button"
          disabled={
            mutation.isLoading ||
            acknowledged ||
            Boolean(retained.current && retained.current.nativeInput.action !== 'decline')
          }
          onClick={() => submit('decline')}
        >
          {localize('com_ui_decline')}
        </Button>
      </div>
    </form>
  );
}
