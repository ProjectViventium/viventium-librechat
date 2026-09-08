import React from 'react';
import mockEnglishTranslations from '~/locales/en/translation.json';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import MemoryInfo from '../MemoryInfo';
import type { MemoryArtifact } from 'librechat-data-provider';

// Mock the localize hook
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      com_ui_memory_updated_items: 'Updated Memories',
      com_ui_memory_deleted_items: 'Deleted Memories',
      com_ui_memory_already_exceeded: `Memory storage already full - exceeded by ${params?.tokens || 0} tokens. Delete existing memories before adding new ones.`,
      com_ui_memory_would_exceed: `Cannot save - would exceed limit by ${params?.tokens || 0} tokens. Delete existing memories to make space.`,
      com_ui_memory_deleted: 'This memory has been deleted',
      com_ui_memory_storage_full: 'Memory Storage Full',
      com_ui_memory_error: 'Memory Error',
      com_ui_updated_successfully: 'Updated successfully',
      com_ui_none_selected: 'None selected',
    };
    const text =
      translations[key] ||
      mockEnglishTranslations[key as keyof typeof mockEnglishTranslations] ||
      key;
    return Object.entries(params ?? {}).reduce(
      (copy, [name, value]) => copy.replace(`{{${name}}}`, String(value)),
      text,
    );
  },
}));

describe('MemoryInfo', () => {
  const createMemoryArtifact = (
    type: 'update' | 'delete' | 'error',
    key: string,
    value?: string,
  ): MemoryArtifact => ({
    type,
    key,
    value: value || `test value for ${key}`,
  });

  describe('Error Memory Display', () => {
    test('shows local capacity without blaming the OpenAI-compatible transport', () => {
      render(
        <MemoryInfo
          memoryArtifacts={[
            {
              type: 'error',
              key: 'system',
              value: JSON.stringify({ errorType: 'host_capacity', provider: 'openai' }),
            },
          ]}
        />,
      );
      expect(
        screen.getByText('Not enough free capacity to save memory right now. Try again shortly.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument();
    });

    test('displays error section when memory is already exceeded', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'already_exceeded', tokenCount: 150 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Memory storage already full - exceeded by 150 tokens. Delete existing memories before adding new ones.',
        ),
      ).toBeInTheDocument();
    });

    test('displays error when memory would exceed limit', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'would_exceed', tokenCount: 50 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Cannot save - would exceed limit by 50 tokens. Delete existing memories to make space.',
        ),
      ).toBeInTheDocument();
    });

    test('displays multiple error messages', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system1',
          value: JSON.stringify({ errorType: 'already_exceeded', tokenCount: 100 }),
        },
        {
          type: 'error',
          key: 'system2',
          value: JSON.stringify({ errorType: 'would_exceed', tokenCount: 25 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(
        screen.getByText(
          'Memory storage already full - exceeded by 100 tokens. Delete existing memories before adding new ones.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'Cannot save - would exceed limit by 25 tokens. Delete existing memories to make space.',
        ),
      ).toBeInTheDocument();
    });

    test('applies correct styling to error messages', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'would_exceed', tokenCount: 50 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      const errorMessage = screen.getByText(
        'Cannot save - would exceed limit by 50 tokens. Delete existing memories to make space.',
      );
      const errorContainer = errorMessage.closest('div');

      expect(errorContainer).toHaveClass('rounded-md');
      expect(errorContainer).toHaveClass('bg-red-50');
      expect(errorContainer).toHaveClass('p-3');
      expect(errorContainer).toHaveClass('text-sm');
      expect(errorContainer).toHaveClass('text-red-800');
      expect(errorContainer).toHaveClass('dark:bg-red-900/20');
      expect(errorContainer).toHaveClass('dark:text-red-400');
    });
  });

  describe('Typed provider failures', () => {
    test.each([
      [
        'usage_limit_reached',
        'OpenAI usage limit reached. Check usage or wait for the limit to reset.',
      ],
      ['provider_auth', 'OpenAI needs sign-in. Reconnect it in Connected Accounts.'],
      ['provider_access_denied', "OpenAI denied access. Check the account's access."],
      ['provider_rate_limited', 'OpenAI is temporarily unavailable. Try again shortly.'],
      ['provider_unavailable', 'OpenAI could not save memory. Try again later.'],
    ])('renders %s with its own action and no raw provider payload', (errorType, expected) => {
      render(
        <MemoryInfo
          memoryArtifacts={[
            createMemoryArtifact(
              'error',
              'system',
              JSON.stringify({
                errorType,
                provider: 'openAI',
                message: 'Bearer synthetic-private-token',
                accountId: 'synthetic-private-account',
                headers: { authorization: 'secret' },
              }),
            ),
          ]}
        />,
      );
      expect(screen.getByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(/synthetic-private|Bearer|secret/)).not.toBeInTheDocument();
    });

    test('keeps primary quota and fallback login failures distinct', () => {
      render(
        <MemoryInfo
          memoryArtifacts={[
            createMemoryArtifact(
              'error',
              'system',
              JSON.stringify({ errorType: 'usage_limit_reached', provider: 'openAI' }),
            ),
            createMemoryArtifact(
              'error',
              'system',
              JSON.stringify({ errorType: 'provider_auth', provider: 'anthropic' }),
            ),
          ]}
        />,
      );
      expect(
        screen.getByText('OpenAI usage limit reached. Check usage or wait for the limit to reset.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Anthropic needs sign-in. Reconnect it in Connected Accounts.'),
      ).toBeInTheDocument();
    });

    test('does not infer provider or error meaning from private error text', () => {
      render(
        <MemoryInfo
          memoryArtifacts={[
            createMemoryArtifact(
              'error',
              'system',
              JSON.stringify({
                errorType: 'unknown',
                provider: 'synthetic-private-provider',
                message: 'OpenAI quota Bearer synthetic-token',
              }),
            ),
          ]}
        />,
      );
      expect(screen.getByText('Memory could not be saved. Try again.')).toBeInTheDocument();
      expect(screen.queryByText(/synthetic|OpenAI/)).not.toBeInTheDocument();
    });

    test('does not invent a token limit when the rejection has no limit', () => {
      render(
        <MemoryInfo
          memoryArtifacts={[
            createMemoryArtifact(
              'error',
              'system',
              JSON.stringify({ errorType: 'key_limit_exceeded' }),
            ),
          ]}
        />,
      );
      expect(
        screen.getByText('This memory item is too long. Shorten it and try again.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/0-token/)).not.toBeInTheDocument();
    });

    test('retains partial-apply uncertainty beside the provider failure', () => {
      render(
        <MemoryInfo
          memoryArtifacts={[
            createMemoryArtifact(
              'error',
              'system',
              JSON.stringify({
                errorType: 'usage_limit_reached',
                provider: 'openAI',
                partialApplied: true,
              }),
            ),
          ]}
        />,
      );
      expect(screen.getByText(/Some changes may have been saved/)).toBeInTheDocument();
    });
  });

  describe('Mixed Memory Types', () => {
    test('displays all sections when different memory types are present', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        createMemoryArtifact('update', 'memory1', 'Updated content'),
        createMemoryArtifact('delete', 'memory2'),
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'would_exceed', tokenCount: 200 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      // Check all sections are present
      expect(screen.getByText('Updated Memories')).toBeInTheDocument();
      expect(screen.getByText('Deleted Memories')).toBeInTheDocument();
      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();

      // Check content
      expect(screen.getByText('memory1')).toBeInTheDocument();
      expect(screen.getByText('Updated content')).toBeInTheDocument();
      expect(screen.getByText('memory2')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Cannot save - would exceed limit by 200 tokens. Delete existing memories to make space.',
        ),
      ).toBeInTheDocument();
    });

    test('only displays sections with content', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'already_exceeded', tokenCount: 10 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      // Only error section should be present
      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();
      expect(screen.queryByText('Updated Memories')).not.toBeInTheDocument();
      expect(screen.queryByText('Deleted Memories')).not.toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    test('handles empty memory artifacts array', () => {
      const { container } = render(<MemoryInfo memoryArtifacts={[]} />);
      expect(container.firstChild).toBeNull();
    });

    test('handles malformed error data gracefully', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: 'invalid json',
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      // Should render generic error message
      expect(screen.getByRole('heading', { name: 'Memory Error' })).toBeInTheDocument();
      expect(screen.getByText('Memory could not be saved. Try again.')).toBeInTheDocument();
    });

    test('handles missing value in error artifact', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          // value is undefined
        } as MemoryArtifact,
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.getByRole('heading', { name: 'Memory Error' })).toBeInTheDocument();
      expect(screen.getByText('Memory could not be saved. Try again.')).toBeInTheDocument();
    });

    test('handles unknown errorType gracefully', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'unknown_type', tokenCount: 30 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      // Should show generic error message for unknown types
      expect(screen.getByRole('heading', { name: 'Memory Error' })).toBeInTheDocument();
      expect(screen.getByText('Memory could not be saved. Try again.')).toBeInTheDocument();
    });

    test('renders backend-provided per-key budget messages without mislabeling them as storage full', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({
            errorType: 'key_limit_exceeded',
            key: 'drafts',
            keyLimit: 1000,
            projectedKeyTokens: 1027,
            message: 'Memory key "drafts" would exceed its 1000-token budget.',
          }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.getByText('Memory Error')).toBeInTheDocument();
      expect(
        screen.getByText(
          'This memory item exceeds its 1000-token limit. Shorten it and try again.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText('Memory Storage Full')).not.toBeInTheDocument();
    });

    test('returns null when no memories of any type exist', () => {
      const memoryArtifacts: MemoryArtifact[] = [{ type: 'unknown' as any, key: 'test' }];

      const { container } = render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('Update and Delete Memory Display', () => {
    test('displays updated memories correctly', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        createMemoryArtifact('update', 'preferences', 'User prefers dark mode'),
        createMemoryArtifact('update', 'location', 'Lives in San Francisco'),
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.getByText('Updated Memories')).toBeInTheDocument();
      expect(screen.getByText('preferences')).toBeInTheDocument();
      expect(screen.getByText('User prefers dark mode')).toBeInTheDocument();
      expect(screen.getByText('location')).toBeInTheDocument();
      expect(screen.getByText('Lives in San Francisco')).toBeInTheDocument();
    });

    test('displays deleted memories correctly', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        createMemoryArtifact('delete', 'old_preference'),
        createMemoryArtifact('delete', 'outdated_info'),
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.getByText('Deleted Memories')).toBeInTheDocument();
      expect(screen.getByText('old_preference')).toBeInTheDocument();
      expect(screen.getByText('outdated_info')).toBeInTheDocument();
    });
  });
});
