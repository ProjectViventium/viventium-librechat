import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ThemeContext } from '@librechat/client';
import ViventiumLogoIcon from '../ViventiumLogoIcon';

/* === VIVENTIUM START ===
 * Feature: Viventium logo theme bridge regression
 * Purpose: The logo component must force explicit app light/dark themes into the embedded SVG.
 */
const renderWithTheme = (theme: 'dark' | 'light' | 'system') =>
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
      <ViventiumLogoIcon />
    </ThemeContext.Provider>,
  );

describe('ViventiumLogoIcon', () => {
  it('renders the Viventium logo asset', () => {
    renderWithTheme('system');

    expect(screen.getByAltText('Viventium')).toHaveAttribute('src', '/assets/logo.svg');
  });

  it('forces the embedded SVG to follow explicit dark theme', () => {
    renderWithTheme('dark');

    expect(screen.getByAltText('Viventium')).toHaveStyle({ colorScheme: 'dark' });
  });

  it('forces the embedded SVG to follow explicit light theme', () => {
    renderWithTheme('light');

    expect(screen.getByAltText('Viventium')).toHaveStyle({ colorScheme: 'light' });
  });
});
/* === VIVENTIUM END === */
