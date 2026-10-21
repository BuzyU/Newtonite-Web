import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LandingPage } from '../src/pages/LandingPage';
import { LoginPage } from '../src/pages/LoginPage';
import { OnboardingPage } from '../src/pages/OnboardingPage';
import { AuthContext, AuthContextValue } from '../src/AuthContext';

describe('Public Entry Points & Quiet Operations Design System', () => {
  const mockAuthContext: AuthContextValue = {
    user: null,
    isLoading: false,
    loading: false,
    login: vi.fn(),
    registerOrg: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    theme: 'light',
    toggleTheme: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('LandingPage Component', () => {
    it('renders the core positioning and dual entry actions without requiring auth', () => {
      render(
        <MemoryRouter>
          <AuthContext.Provider value={mockAuthContext}>
            <LandingPage />
          </AuthContext.Provider>
        </MemoryRouter>
      );

      // Verify product positioning text
      expect(screen.getByText('Operational work, with clear ownership.')).toBeDefined();

      // Verify primary action
      const createBtn = screen.getByRole('link', { name: /create your organization/i });
      expect(createBtn).toBeDefined();
      expect(createBtn.getAttribute('href')).toBe('/register');

      // Verify secondary action
      const signInLinks = screen.getAllByRole('link', { name: /sign in/i });
      expect(signInLinks.length).toBeGreaterThanOrEqual(1);

      // Verify Google login is completely absent
      expect(screen.queryByText(/continue with google/i)).toBeNull();
    });
  });

  describe('LoginPage Component', () => {
    it('renders email and password inputs with password visibility toggle and remember-me checkbox', () => {
      render(
        <MemoryRouter>
          <AuthContext.Provider value={mockAuthContext}>
            <LoginPage />
          </AuthContext.Provider>
        </MemoryRouter>
      );

      // Form inputs
      expect(screen.getByLabelText(/email address/i)).toBeDefined();
      const passwordInput = screen.getByLabelText(/^password/i);
      expect(passwordInput).toBeDefined();
      expect(passwordInput.getAttribute('type')).toBe('password');

      // Visibility toggle
      const toggleBtn = screen.getByRole('button', { name: /show password/i });
      expect(toggleBtn).toBeDefined();
      fireEvent.click(toggleBtn);
      expect(passwordInput.getAttribute('type')).toBe('text');

      // Remember me checkbox
      const rememberCheckbox = screen.getByLabelText(/remember me on this device/i) as HTMLInputElement;
      expect(rememberCheckbox).toBeDefined();
      expect(rememberCheckbox.checked).toBe(true);

      // Verify NO Google sign-in button
      expect(screen.queryByText(/continue with google/i)).toBeNull();
    });

    it('invokes login with email, password, and remember flag on submit', async () => {
      render(
        <MemoryRouter>
          <AuthContext.Provider value={mockAuthContext}>
            <LoginPage />
          </AuthContext.Provider>
        </MemoryRouter>
      );

      fireEvent.change(screen.getByLabelText(/email address/i), {
        target: { value: 'alice@company.com' },
      });
      fireEvent.change(screen.getByLabelText(/^password/i), {
        target: { value: 'SecretPassword123!' },
      });

      const submitBtn = screen.getByRole('button', { name: /sign in/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(mockAuthContext.login).toHaveBeenCalledWith('alice@company.com', 'SecretPassword123!', true);
      });
    });
  });

  describe('OnboardingPage Component', () => {
    it('guides through organization creation wizard with validation', async () => {
      render(
        <MemoryRouter>
          <AuthContext.Provider value={mockAuthContext}>
            <OnboardingPage />
          </AuthContext.Provider>
        </MemoryRouter>
      );

      // Step 1: Organization profile
      expect(screen.getByText(/create organization workspace/i)).toBeDefined();
      const orgNameInput = screen.getByLabelText(/organization name/i);
      fireEvent.change(orgNameInput, { target: { value: 'Vanguard Systems' } });

      const nextToStep2Btn = screen.getByRole('button', { name: /continue to admin account/i });
      fireEvent.click(nextToStep2Btn);

      // Step 2: Administrator identity
      await waitFor(() => {
        expect(screen.getByText(/set master administrator/i)).toBeDefined();
      });

      const nameInput = screen.getByLabelText(/admin full name/i);
      const emailInput = screen.getByLabelText(/work email address/i);
      const passInput = screen.getByLabelText(/master password/i);

      fireEvent.change(nameInput, { target: { value: 'Vanguard Admin' } });
      fireEvent.change(emailInput, { target: { value: 'admin@vanguard.local' } });
      fireEvent.change(passInput, { target: { value: 'ValidStrongPassword#2026!' } });

      const nextToStep3Btn = screen.getByRole('button', { name: /review configuration/i });
      fireEvent.click(nextToStep3Btn);

      // Step 3: Review & default teams
      await waitFor(() => {
        expect(screen.getByText(/confirm & launch workspace/i)).toBeDefined();
        expect(screen.getByText('Vanguard Systems')).toBeDefined();
        expect(screen.getByText('admin@vanguard.local')).toBeDefined();
      });

      // Submit final creation
      const createOrgBtn = screen.getByRole('button', { name: /launch organization workspace/i });
      fireEvent.click(createOrgBtn);

      await waitFor(() => {
        expect(mockAuthContext.registerOrg).toHaveBeenCalledWith({
          orgName: 'Vanguard Systems',
          orgSlug: 'vanguard-systems',
          adminName: 'Vanguard Admin',
          adminEmail: 'admin@vanguard.local',
          password: 'ValidStrongPassword#2026!',
        });
      });
    });
  });
});
