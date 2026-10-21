import React, { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useRealtime } from '../useRealtime';
import { isServerWaking } from '../api';
import { CreateItemModal } from './CreateItemModal';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import styles from './Layout.module.css';

export const Layout: React.FC = () => {
  const { user, logout, theme, toggleTheme } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [waking, setWaking] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Subscribe to real-time events
  const { status: realtimeStatus } = useRealtime();

  // Subscribe to wake-up banner
  useEffect(() => {
    return isServerWaking.subscribe((val: boolean) => setWaking(val));
  }, []);

  // Sync search input with URL if on /work
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get('q') || '';
    setSearchValue(q);
  }, [location.search]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input, textarea, or select
      const activeEl = document.activeElement;
      const isInput =
        activeEl?.tagName === 'INPUT' ||
        activeEl?.tagName === 'TEXTAREA' ||
        activeEl?.tagName === 'SELECT' ||
        (activeEl as HTMLElement)?.isContentEditable;

      if (e.key === 'Escape') {
        if (isCreateOpen) setIsCreateOpen(false);
        if (isShortcutsOpen) setIsShortcutsOpen(false);
        return;
      }

      if (isInput) return;

      if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === 'c') {
        e.preventDefault();
        setIsCreateOpen(true);
      } else if (e.key === '?') {
        e.preventDefault();
        setIsShortcutsOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isCreateOpen, isShortcutsOpen]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchValue.trim()) {
      navigate(`/work?q=${encodeURIComponent(searchValue.trim())}`);
    } else {
      navigate('/work');
    }
  };

  return (
    <div className={styles.appContainer}>
      {/* Sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.brandTitle}>
            <span>NEWTONITE</span>
            <span className={styles.brandTag}>
              {user?.orgSlug ? user.orgSlug.toUpperCase().slice(0, 6) : 'OPS'}
            </span>
          </div>
        </div>

        <div className={styles.quickAction}>
          <button
            type="button"
            className={styles.createBtn}
            onClick={() => setIsCreateOpen(true)}
            id="create-item-button"
          >
            <span>+ New Item</span>
            <kbd className={styles.kbdHint}>c</kbd>
          </button>
        </div>

        <nav className={styles.navSection}>
          <div className={styles.navGroupTitle}>Views</div>
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
            }
          >
            <span>My Attention</span>
          </NavLink>
          <NavLink
            to="/work"
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
            }
          >
            <span>All Work</span>
          </NavLink>

          <div className={styles.navGroupTitle} style={{ marginTop: 'var(--space-4)' }}>
            Organization
          </div>
          {(user?.is_org_admin || user?.isOrgAdmin) && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
              }
              id="nav-admin-console"
            >
              <span>Admin Console</span>
            </NavLink>
          )}
          <NavLink
            to="/teams"
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
            }
          >
            <span>Teams & Members</span>
          </NavLink>
          <NavLink
            to="/dead-letters"
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
            }
          >
            <span>Dead Letters (Admin)</span>
          </NavLink>
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.userCard}>
            <span className={styles.userName}>
              {user?.name} {(user?.is_org_admin || user?.isOrgAdmin) && <span style={{ fontSize: '10px', color: 'var(--color-accent)' }}>[Admin]</span>}
            </span>
            <span className={styles.userEmail} title={user?.email}>
              {user?.email}
            </span>
          </div>
          <div className={styles.footerActions}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={toggleTheme}
              style={{ fontSize: '11px', padding: '4px 6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}
              title="Toggle Light / Dark theme"
            >
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={logout}
              style={{ fontSize: '11px', padding: '4px 6px', color: 'var(--color-danger)' }}
              id="logout-button"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main content wrapper */}
      <div className={styles.mainWrapper}>
        {/* Render wake-up banner */}
        {waking && (
          <div className={styles.wakeupBanner}>
            <span>The server is waking up, this can take up to a minute...</span>
          </div>
        )}

        {/* Top bar */}
        <header className={styles.topBar}>
          <form onSubmit={handleSearchSubmit} className={styles.searchBox}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: 'var(--color-text-muted)', marginRight: '6px', flexShrink: 0 }}
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              className={styles.searchInput}
              placeholder="Search items by title, ref, or description..."
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              id="global-search-input"
            />
            <kbd className={styles.kbdHint} style={{ border: 'none', background: 'transparent' }}>
              /
            </kbd>
          </form>

          <div className={styles.topBarRight}>
            <div className={styles.realtimeBadge} title={`Realtime mode: ${realtimeStatus}`}>
              <div
                className={`${styles.pulseDot} ${
                  realtimeStatus === 'live' ? styles.dotLive : styles.dotReconnecting
                }`}
              />
              <span style={{ textTransform: 'capitalize' }}>
                {realtimeStatus === 'live' ? 'Live' : realtimeStatus === 'polling' ? 'Polling' : 'Connecting'}
              </span>
            </div>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setIsShortcutsOpen(true)}
              style={{ padding: '4px 8px', fontSize: '12px' }}
              title="Keyboard shortcuts"
              id="shortcuts-button"
            >
              ?
            </button>
          </div>
        </header>

        {/* Dynamic page content */}
        <main className={styles.contentArea}>
          <Outlet />
        </main>
      </div>

      {/* Modals */}
      <CreateItemModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
      <KeyboardShortcutsModal isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />
    </div>
  );
};
