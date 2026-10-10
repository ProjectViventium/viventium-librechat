import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import Nav from './Nav';

jest.mock('~/hooks', () => ({ useLocalize: () => (value) => value }));
jest.mock('~/utils', () => ({ cn: (...values) => values.filter(Boolean).join(' ') }));
jest.mock('~/Providers', () => {
  const React = require('react');
  const Context = React.createContext(null);
  return {
    ActivePanelProvider: ({ children, defaultActive }) => {
      const [active, setActive] = React.useState(defaultActive || '');
      return <Context.Provider value={{ active, setActive }}>{children}</Context.Provider>;
    },
    useActivePanel: () => React.useContext(Context),
  };
});

const icon = () => <span aria-hidden="true" />;
const memory = { id: 'memories', title: 'Memories', icon, Component: () => <p>Saved memory</p> };
const active = { id: 'active-work', title: 'Active work', icon, Component: () => <p>Working</p> };

describe('right-nav pending target identity while readiness inserts a link', () => {
  it.each([true, false])(
    'keeps the selected memory target across insertion, collapsed=%s',
    (isCollapsed) => {
      const feelings = jest.fn();
      const links = [
        { id: 'prompts', title: 'Prompts', icon, Component: () => <p>Prompts panel</p> },
        { id: 'feelings', title: 'Feelings', icon, onClick: feelings },
        memory,
      ];
      const props = { isCollapsed, resize: jest.fn() };
      const { rerender } = render(<Nav {...props} links={links} />);
      const selectedMemoryTarget = screen.getByRole('button', { name: 'Memories', exact: true });
      rerender(<Nav {...props} links={[active, ...links]} />);
      fireEvent.click(selectedMemoryTarget);
      expect(feelings).not.toHaveBeenCalled();
      expect(selectedMemoryTarget).toBe(
        screen.getByRole('button', { name: 'Memories', exact: true }),
      );
      if (!isCollapsed) expect(screen.getByText('Saved memory')).toBeVisible();
    },
  );

  it.each([true, false])(
    'keeps normal navigation and removed links truthful, collapsed=%s',
    (isCollapsed) => {
      const feelings = jest.fn();
      const links = [{ id: 'feelings', title: 'Feelings', icon, onClick: feelings }, memory];
      const props = { isCollapsed, resize: jest.fn() };
      const { rerender } = render(<Nav {...props} links={links} />);
      fireEvent.click(screen.getByRole('button', { name: 'Feelings', exact: true }));
      expect(feelings).toHaveBeenCalledTimes(1);
      rerender(<Nav {...props} links={[memory]} />);
      expect(
        screen.queryByRole('button', { name: 'Feelings', exact: true }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Memories', exact: true }));
      expect(feelings).toHaveBeenCalledTimes(1);
      if (!isCollapsed) expect(screen.getByText('Saved memory')).toBeVisible();
    },
  );
});
