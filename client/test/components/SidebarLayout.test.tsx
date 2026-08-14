import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import SidebarLayout, { type SidebarNavItem } from '../../src/components/SidebarLayout';

function DummyIcon(props: { className?: string }) {
  return <svg data-testid="dummy-icon" className={props.className} />;
}

const NAV: SidebarNavItem[] = [
  { to: '/', label: 'dashboard', end: true, icon: DummyIcon },
  { to: '/other', label: 'other page', icon: DummyIcon },
];

function renderLayout(storageKey = 'test_sidebar_collapsed') {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<SidebarLayout title="admin" nav={NAV} storageKey={storageKey} />}>
          <Route index element={<div>content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('SidebarLayout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders nav labels and title when expanded by default', () => {
    renderLayout();
    expect(screen.getByText('admin')).toBeDefined();
    expect(screen.getByText('dashboard')).toBeDefined();
    expect(screen.getByText('other page')).toBeDefined();
    expect(screen.getByText('collapse')).toBeDefined();
  });

  it('collapses on toggle click, hiding labels but keeping icons', () => {
    renderLayout();
    fireEvent.click(screen.getByTitle('collapse'));

    expect(screen.queryByText('dashboard')).toBeNull();
    expect(screen.queryByText('other page')).toBeNull();
    expect(screen.getAllByTestId('dummy-icon').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTitle('expand')).toBeDefined();
  });

  it('persists collapsed state to localStorage under the given key', () => {
    renderLayout('my_storage_key');
    fireEvent.click(screen.getByTitle('collapse'));
    expect(localStorage.getItem('my_storage_key')).toBe('1');
  });

  it('restores collapsed state from localStorage on mount', () => {
    localStorage.setItem('my_storage_key', '1');
    renderLayout('my_storage_key');
    expect(screen.queryByText('dashboard')).toBeNull();
    expect(screen.getByTitle('expand')).toBeDefined();
  });

  it('renders the collapse-aware footer', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <SidebarLayout
                title="admin"
                nav={NAV}
                storageKey="footer_test_key"
                footer={(collapsed) => <div>footer-{collapsed ? 'collapsed' : 'expanded'}</div>}
              />
            }
          >
            <Route index element={<div>content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('footer-expanded')).toBeDefined();
    fireEvent.click(screen.getByTitle('collapse'));
    expect(screen.getByText('footer-collapsed')).toBeDefined();
  });
});
