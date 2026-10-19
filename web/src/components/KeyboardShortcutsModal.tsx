import React from 'react';
import styles from './Layout.module.css';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()} style={{ padding: 'var(--space-6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600 }}>Keyboard Shortcuts</h2>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            aria-label="Close modal"
            style={{ padding: '4px 8px', fontSize: '13px' }}
          >
            Esc
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-border-subtle)', paddingBottom: 'var(--space-2)' }}>
            <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>Focus Search</span>
            <kbd className={styles.kbdHint}>/</kbd>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-border-subtle)', paddingBottom: 'var(--space-2)' }}>
            <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>Create New Item</span>
            <kbd className={styles.kbdHint}>c</kbd>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-border-subtle)', paddingBottom: 'var(--space-2)' }}>
            <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>Navigate Down / Up in List</span>
            <span style={{ display: 'flex', gap: '4px' }}>
              <kbd className={styles.kbdHint}>j</kbd>
              <kbd className={styles.kbdHint}>k</kbd>
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-border-subtle)', paddingBottom: 'var(--space-2)' }}>
            <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>Open Selected Item</span>
            <kbd className={styles.kbdHint}>Enter</kbd>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-border-subtle)', paddingBottom: 'var(--space-2)' }}>
            <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>Show / Hide Shortcuts</span>
            <kbd className={styles.kbdHint}>?</kbd>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>Close Modals</span>
            <kbd className={styles.kbdHint}>Esc</kbd>
          </div>
        </div>

        <div style={{ marginTop: 'var(--space-6)', textAlign: 'right' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
