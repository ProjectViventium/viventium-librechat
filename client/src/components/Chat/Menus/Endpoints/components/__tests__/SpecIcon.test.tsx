import type React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ThemeContext } from '@librechat/client';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import SpecIcon from '../SpecIcon';

/* === VIVENTIUM START ===
 * Feature: Viventium model-spec icon regression
 * Purpose: Local model-spec asset paths must render as theme-aware Viventium logos, not feathers.
 */
const renderWithTheme = (ui: React.ReactElement, theme: 'dark' | 'light' | 'system' = 'system') =>
  render(
    <ThemeContext.Provider
      value={{
        theme,
        setTheme: jest.fn(),
        setThemeRGB: jest.fn(),
        setThemeName: jest.fn(),
        resetTheme: jest.fn(),
      }}
    >
      {ui}
    </ThemeContext.Provider>,
  );

describe('SpecIcon', () => {
  it('renders configured local image icon URLs instead of the agent fallback icon', () => {
    const currentSpec = {
      name: 'viventium',
      label: 'Viventium',
      iconURL: '/assets/logo.svg',
      preset: {
        endpoint: EModelEndpoint.agents,
        model: 'agent-model',
        agent_id: 'agent-1',
      },
    } as unknown as TModelSpec;

    renderWithTheme(<SpecIcon currentSpec={currentSpec} endpointsConfig={{}} />, 'dark');

    const logo = screen.getByAltText('viventium');
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute('src', '/assets/logo.svg');
    expect(logo).toHaveStyle({ colorScheme: 'dark' });
    expect(document.querySelector('.lucide-feather')).not.toBeInTheDocument();
  });
});
/* === VIVENTIUM END === */
