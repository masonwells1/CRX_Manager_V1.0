import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, UserPlus, Pencil, Shield, Users, KeyRound, Fuel, ClipboardList, Bell, FileText } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import SplitHeading from '../components/ui/SplitHeading';
import Skeleton from '../components/ui/Skeleton';
import EmptyState from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { logActivity } from '../lib/activityLogger';
import { supabase, checkMutationResult, sanitizeError, assertRpcResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { getPagesForRole, getCategories } from '../lib/pagePermissions';
import { Sentry } from '../lib/sentry';
import {
  DEFAULT_FUEL_SURCHARGE,
  parseFuelSurchargeConfig,
  serializeFuelSurchargeConfig,
  fuelSurchargeIsActive,
  validateFuelSurchargeConfig,
  fuelSurchargeRateUnit,
  type FuelSurchargeConfig,
  type FuelSurchargeBasis,
} from '../lib/fuelSurcharge';
import {
  DEFAULT_CUSTOM_CONFIG,
  parseCustomConfig,
  serializeCustomConfig,
  type ApplicatorSheetCustomConfig,
} from '../lib/applicatorSheetData';
import {
  DEFAULT_PRE_NOTIFICATION_TEMPLATE,
  parsePreNotificationTemplate,
  type PreNotificationTemplate,
} from '../lib/preNotification';
import {
  DEFAULT_POST_NOTIFICATION_TEMPLATE,
  parsePostNotificationTemplate,
  type PostNotificationTemplate,
} from '../lib/postNotification';
import {
  AUTO_DRAFT_SETTING_KEY,
  DEFAULT_AUTO_DRAFT_ENABLED,
  parseAutoDraftEnabled,
  serializeAutoDraftEnabled,
} from '../lib/autoDraftSetting';
import {
  LABEL_RATE_GUARDRAIL_MODE_KEY,
  DEFAULT_GUARDRAIL_MODE,
  parseGuardrailMode,
  serializeGuardrailMode,
  type GuardrailMode,
} from '../lib/labelGuardrailSetting';
import type { Profile, AppSetting, UserRole } from '../types';

// --- Permissions Panel ---

function UserPermissionsPanel({
  role,
  deniedPages,
  onChange,
}: {
  role: UserRole;
  deniedPages: string[];
  onChange: (pages: string[]) => void;
}) {
  const rolePages = getPagesForRole(role);
  const categories = getCategories(rolePages);

  if (role === 'admin') return null;
  if (rolePages.length === 0) return null;

  const allowedCount = rolePages.length - deniedPages.length;

  const togglePage = (key: string) => {
    if (deniedPages.includes(key)) {
      onChange(deniedPages.filter((k) => k !== key));
    } else {
      onChange([...deniedPages, key]);
    }
  };

  const enableAll = () => onChange([]);
  const disableAll = () => onChange(rolePages.map((p) => p.key));

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-crx-green" />
          <span className="text-sm font-medium text-nav-dark">
            Page Access ({allowedCount}/{rolePages.length})
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={enableAll}
            className="text-xs text-crx-green hover:underline"
          >
            Enable All
          </button>
          <span className="text-gray-300">|</span>
          <button
            type="button"
            onClick={disableAll}
            className="text-xs text-red-500 hover:underline"
          >
            Disable All
          </button>
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto px-3 py-2 space-y-3">
        {categories.map((cat) => {
          const catPages = rolePages.filter((p) => p.category === cat);
          return (
            <div key={cat}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-1">
                {cat}
              </p>
              <div className="space-y-1">
                {catPages.map((page) => {
                  const allowed = !deniedPages.includes(page.key);
                  return (
                    <label
                      key={page.key}
                      className="flex items-center gap-2 cursor-pointer py-0.5"
                    >
                      <input
                        type="checkbox"
                        checked={allowed}
                        onChange={() => togglePage(page.key)}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
                      />
                      <span className={`text-sm ${allowed ? 'text-nav-dark' : 'text-gray-400 line-through'}`}>
                        {page.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Settings Page ---

export default function SettingsPage() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const adminUpdateIdem = useIdempotencyKey('admin_update_profile', profile?.id || '');

  const [companyName, setCompanyName] = useState('');
  const [companyPhone, setCompanyPhone] = useState('');
  const [companyEmail, setCompanyEmail] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');
  const [defaultValidDays, setDefaultValidDays] = useState('30');
  const [arReminderDays, setArReminderDays] = useState('30');
  const [defaultTier, setDefaultTier] = useState('1');
  // #32: Fuel Surcharge — OFF by default, rate blank. The owner sets the rule.
  const [fuelSurcharge, setFuelSurcharge] = useState<FuelSurchargeConfig>(DEFAULT_FUEL_SURCHARGE);
  const [savingFuel, setSavingFuel] = useState(false);
  // §4: Auto-draft invoice on job completion — OFF by default (never auto-posts).
  const [autoDraftEnabled, setAutoDraftEnabled] = useState<boolean>(DEFAULT_AUTO_DRAFT_ENABLED);
  const [savingAutoDraft, setSavingAutoDraft] = useState(false);
  // §5: Label-rate guardrail mode — WARN by default (never blocks a save).
  const [guardrailMode, setGuardrailMode] = useState<GuardrailMode>(DEFAULT_GUARDRAIL_MODE);
  const [savingGuardrail, setSavingGuardrail] = useState(false);
  // #9: Custom applicator field-sheet layout (LAYOUT ONLY — header/logo/footer +
  // optional column toggles). Blank by default => standard CRX header.
  const [sheetConfig, setSheetConfig] = useState<ApplicatorSheetCustomConfig>(DEFAULT_CUSTOM_CONFIG);
  const [savingSheet, setSavingSheet] = useState(false);
  // Field-app parity #40: editable pre-application notice template (subject + body).
  const [preNoticeTemplate, setPreNoticeTemplate] = useState<PreNotificationTemplate>(DEFAULT_PRE_NOTIFICATION_TEMPLATE);
  const [savingPreNotice, setSavingPreNotice] = useState(false);
  // Field-app parity #41: editable post-application notice template (subject + body).
  const [postNoticeTemplate, setPostNoticeTemplate] = useState<PostNotificationTemplate>(DEFAULT_POST_NOTIFICATION_TEMPLATE);
  const [savingPostNotice, setSavingPostNotice] = useState(false);
  const [users, setUsers] = useState<Profile[]>([]);
  const [savingCompany, setSavingCompany] = useState(false);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('sales_rep');
  const [newPassword, setNewPassword] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);

  // Edit user state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<Profile | null>(null);
  const [editRole, setEditRole] = useState<UserRole>('sales_rep');
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);
  const [editDeniedPages, setEditDeniedPages] = useState<string[]>([]);
  const [savingUser, setSavingUser] = useState(false);
  const [deactivateConfirmOpen, setDeactivateConfirmOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<Profile | null>(null);
  const [adminSetPassword, setAdminSetPassword] = useState('');
  const [adminConfirmPassword, setAdminConfirmPassword] = useState('');
  const [settingPassword, setSettingPassword] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);

  useEffect(() => {
    if (role !== 'admin') {
      navigate('/');
      return;
    }
    Promise.all([fetchSettings(), fetchUsers()]).finally(() => setPageLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, navigate]);

  const fetchSettings = async () => {
    const { data, error } = await supabase.from('app_settings').select('*');
    if (error) {
      toast('error', 'Failed to load settings');
      return;
    }
    const settings = (data || []) as AppSetting[];
    const map: Record<string, string> = {};
    settings.forEach((s) => { map[s.setting_key] = s.setting_value; });
    setCompanyName(map['company_name'] || '');
    setCompanyPhone(map['company_phone'] || '');
    setCompanyEmail(map['company_email'] || '');
    setCompanyAddress(map['company_address'] || '');
    setDefaultValidDays(map['default_quote_valid_days'] || '30');
    setArReminderDays(map['ar_reminder_days'] || '30');
    setDefaultTier(map['default_tier'] || '1');
    // #32: blank/absent => the inert OFF default (never invents a rate).
    setFuelSurcharge(parseFuelSurchargeConfig(map['fuel_surcharge']));
    // §4: blank/absent/anything-but-'true' => OFF (the safe default).
    setAutoDraftEnabled(parseAutoDraftEnabled(map[AUTO_DRAFT_SETTING_KEY]));
    // §5: blank/absent/anything-but-'block' => WARN (the safe default; never blocks).
    setGuardrailMode(parseGuardrailMode(map[LABEL_RATE_GUARDRAIL_MODE_KEY]));
    // #9: blank/absent => standard CRX header + all optional columns shown.
    setSheetConfig(parseCustomConfig(map['applicator_sheet_custom']));
    // #40: blank/absent => the seeded default pre-notification wording.
    setPreNoticeTemplate(parsePreNotificationTemplate(map['pre_application_notice_template']));
    // #41: blank/absent => the seeded default post-notification wording.
    setPostNoticeTemplate(parsePostNotificationTemplate(map['post_application_notice_template']));
  };

  const fetchUsers = async () => {
    // Codex P2 (PR #59, 2026-05-16): exclude entity_recipient service profiles
    // (CMCTW LLC, Crop Rx Solutions) from the user-management table — they
    // can't log in and showing them in the Edit/Set-Password UI risks an
    // admin accidentally setting a real password and defeating the
    // "can never log in" guarantee from migration 20260516090000.
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .neq('role', 'entity_recipient')
      .order('full_name');
    if (error) {
      toast('error', 'Failed to load users');
      return;
    }
    setUsers((data || []) as Profile[]);
  };

  const saveSetting = async (key: string, value: string) => {
    const result = await supabase
      .from('app_settings')
      .upsert(
        { setting_key: key, setting_value: value, updated_at: new Date().toISOString() },
        { onConflict: 'setting_key' }
      )
      .select();
    checkMutationResult(result, `Save setting: ${key}`);
  };

  const saveCompanyInfo = async () => {
    setSavingCompany(true);
    try {
      await Promise.all([
        saveSetting('company_name', companyName),
        saveSetting('company_phone', companyPhone),
        saveSetting('company_email', companyEmail),
        saveSetting('company_address', companyAddress),
      ]);
      toast('success', 'Company info saved');
      if (profile) logActivity({ event: 'settings_updated', description: 'Company info updated', performedBy: profile.id });
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSavingCompany(false);
  };

  const saveDefaults = async () => {
    setSavingDefaults(true);
    // Clamp the AR reminder threshold to exactly what get_ar_reminder_candidates enforces
    // (1..3650 whole days) so the stored/shown value can never diverge from the cadence used.
    const nReminder = parseInt(arReminderDays, 10);
    const normalizedReminderDays = String(Number.isFinite(nReminder) ? Math.min(Math.max(nReminder, 1), 3650) : 30);
    setArReminderDays(normalizedReminderDays);
    try {
      await Promise.all([
        saveSetting('default_quote_valid_days', defaultValidDays),
        saveSetting('ar_reminder_days', normalizedReminderDays),
        saveSetting('default_tier', defaultTier),
      ]);
      toast('success', 'Default settings saved');
      if (profile) logActivity({ event: 'settings_updated', description: 'Default settings updated', performedBy: profile.id });
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSavingDefaults(false);
  };

  const saveFuelSurcharge = async () => {
    // #32: UI guard. OFF/blank are never errors; only an inconsistent ON config is.
    const err = validateFuelSurchargeConfig(fuelSurcharge);
    if (err) {
      toast('error', err);
      return;
    }
    setSavingFuel(true);
    try {
      await saveSetting('fuel_surcharge', serializeFuelSurchargeConfig(fuelSurcharge));
      toast('success', 'Fuel surcharge settings saved');
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: `Fuel surcharge ${fuelSurcharge.enabled ? 'enabled' : 'disabled'} (basis: ${fuelSurcharge.basis || 'none'}, rate: ${fuelSurcharge.rate.trim() || 'blank'})`,
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingFuel(false);
  };

  const saveAutoDraft = async () => {
    setSavingAutoDraft(true);
    try {
      await saveSetting(AUTO_DRAFT_SETTING_KEY, serializeAutoDraftEnabled(autoDraftEnabled));
      toast('success', `Auto-invoice ${autoDraftEnabled ? 'enabled' : 'disabled'}`);
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: `Auto-draft invoice on job completion ${autoDraftEnabled ? 'enabled' : 'disabled'} (drafts only — never auto-posts)`,
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingAutoDraft(false);
  };

  const saveGuardrailMode = async () => {
    setSavingGuardrail(true);
    try {
      await saveSetting(LABEL_RATE_GUARDRAIL_MODE_KEY, serializeGuardrailMode(guardrailMode));
      toast('success', `Label-rate guardrail set to ${guardrailMode === 'block' ? 'Block (admin override required)' : 'Warn'}`);
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: `Label-rate guardrail mode set to '${guardrailMode}' (warn never blocks a save; block requires an admin override with a logged reason)`,
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingGuardrail(false);
  };

  const saveSheetConfig = async () => {
    // #9: layout only — there is nothing to validate (any combination is valid;
    // blank fields fall back to the standard CRX header).
    setSavingSheet(true);
    try {
      await saveSetting('applicator_sheet_custom', serializeCustomConfig(sheetConfig));
      toast('success', 'Custom applicator sheet settings saved');
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: 'Custom applicator field-sheet layout updated',
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingSheet(false);
  };

  // #40: persist the editable pre-application notice wording. Subject + body must
  // both be non-blank (a blank template would email an empty notice).
  const savePreNoticeTemplate = async () => {
    if (!preNoticeTemplate.subject.trim() || !preNoticeTemplate.body.trim()) {
      toast('error', 'The pre-notification subject and message cannot be blank.');
      return;
    }
    setSavingPreNotice(true);
    try {
      await saveSetting(
        'pre_application_notice_template',
        JSON.stringify({ subject: preNoticeTemplate.subject, body: preNoticeTemplate.body }),
      );
      toast('success', 'Pre-notification message saved');
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: 'Pre-application notice template updated',
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingPreNotice(false);
  };

  // #41: persist the editable post-application notice wording. Subject + body must
  // both be non-blank (a blank template would email an empty notice).
  const savePostNoticeTemplate = async () => {
    if (!postNoticeTemplate.subject.trim() || !postNoticeTemplate.body.trim()) {
      toast('error', 'The post-notification subject and message cannot be blank.');
      return;
    }
    setSavingPostNotice(true);
    try {
      await saveSetting(
        'post_application_notice_template',
        JSON.stringify({ subject: postNoticeTemplate.subject, body: postNoticeTemplate.body }),
      );
      toast('success', 'Post-notification message saved');
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: 'Post-application notice template updated',
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingPostNotice(false);
  };

  const toggleSheetColumn = (key: keyof ApplicatorSheetCustomConfig['columns']) => {
    setSheetConfig((c) => ({ ...c, columns: { ...c.columns, [key]: !c.columns[key] } }));
  };

  const handleCreateUser = async () => {
    if (!newEmail.trim() || !newName.trim() || !newPassword.trim()) return;
    if (newPassword.length < 6) {
      toast('error', 'Password must be at least 6 characters');
      return;
    }
    setCreatingUser(true);
    try {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        toast('error', 'You are not logged in. Please sign in again.');
        setCreatingUser(false);
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-user`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            email: newEmail,
            password: newPassword,
            full_name: newName,
            role: newRole,
            phone: newPhone || null,
          }),
        }
      );

      const data = await response.json();
      if (!response.ok || data?.error) {
        toast('error', data?.error || `Request failed (${response.status})`);
      } else {
        toast('success', 'User created successfully');
        if (profile) logActivity({ event: 'user_created', description: `User ${newName} (${newRole}) created`, performedBy: profile.id });
        setUserModalOpen(false);
        setNewEmail('');
        setNewName('');
        setNewPassword('');
        setNewRole('sales_rep');
        setNewPhone('');
        fetchUsers();
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'create_user' } });
      toast('error', err instanceof Error ? err.message : 'Failed to create user');
    }
    setCreatingUser(false);
  };

  const openEditModal = (user: Profile) => {
    setEditingUser(user);
    setEditName(user.full_name);
    setEditRole(user.role);
    setEditPhone(user.phone || '');
    setEditIsActive(user.is_active);
    setEditDeniedPages(user.denied_pages || []);
    setEditModalOpen(true);
  };

  // When role changes, prune denied pages that don't apply to the new role
  const handleEditRoleChange = useCallback((newRoleValue: UserRole) => {
    setEditRole(newRoleValue);
    if (newRoleValue === 'admin') {
      setEditDeniedPages([]);
    } else {
      const validKeys = getPagesForRole(newRoleValue).map((p) => p.key);
      setEditDeniedPages((prev) => prev.filter((k) => validKeys.includes(k)));
    }
  }, []);

  const handleEditUser = async () => {
    if (!editingUser) return;
    // If deactivating, show confirm modal first
    if (editIsActive === false && editingUser.is_active === true) {
      setDeactivateConfirmOpen(true);
      return;
    }
    await executeEditUser();
  };

  const executeEditUser = async () => {
    if (!editingUser) return;
    setDeactivateConfirmOpen(false);
    setSavingUser(true);
    try {
      const idemKey = adminUpdateIdem.getKey();
      const { data, error } = await supabase.rpc('admin_update_profile', {
        target_user_id: editingUser.id,
        new_role: editRole,
        new_full_name: editName,
        new_phone: editPhone || undefined,
        new_is_active: editIsActive,
        new_denied_pages: editRole === 'admin' ? [] : editDeniedPages,
        p_idempotency_key: idemKey,
      });
      if (error) {
        // trg_guard_last_active_admin refuses to deactivate the last active admin,
        // which would otherwise lock the account out of its own app.
        toast('error', /LAST_ACTIVE_ADMIN/.test(String((error as { message?: string })?.message ?? ''))
          ? 'You cannot deactivate the only active admin. Make someone else an active admin first.'
          : sanitizeError(error));
      } else {
        const updateResult = assertRpcResult<{ error?: string }>(data, 'admin_update_profile');
        if (updateResult?.error) {
          toast('error', updateResult.error);
        } else {
          adminUpdateIdem.resetKey();
          toast('success', 'User updated successfully');
          if (profile) logActivity({ event: 'user_updated', description: `User ${editName} updated (role: ${editRole}, active: ${editIsActive})`, performedBy: profile.id });
          setEditModalOpen(false);
          setEditingUser(null);
          fetchUsers();
        }
      }
    } catch {
      toast('error', 'Failed to update user');
    }
    setSavingUser(false);
  };

  const openPasswordModal = (user: Profile) => {
    setPasswordTarget(user);
    setAdminSetPassword('');
    setAdminConfirmPassword('');
    setPasswordModalOpen(true);
  };

  const handleSetPassword = async () => {
    if (!passwordTarget) return;
    if (adminSetPassword.length < 8) {
      toast('error', 'Password must be at least 8 characters');
      return;
    }
    if (adminSetPassword !== adminConfirmPassword) {
      toast('error', 'Passwords do not match');
      return;
    }
    setSettingPassword(true);
    try {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        toast('error', 'You are not logged in. Please sign in again.');
        setSettingPassword(false);
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-user`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            action: 'reset_password',
            user_id: passwordTarget.id,
            password: adminSetPassword,
          }),
        }
      );

      const data = await response.json();
      if (!response.ok || data?.error) {
        toast('error', data?.error || `Request failed (${response.status})`);
      } else {
        toast('success', `Password updated for ${passwordTarget.full_name}`);
        if (profile) logActivity({ event: 'user_password_reset', description: `Admin reset password for ${passwordTarget.full_name}`, performedBy: profile.id });
        setPasswordModalOpen(false);
        setPasswordTarget(null);
        setAdminSetPassword('');
        setAdminConfirmPassword('');
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'admin_reset_password' } });
      toast('error', err instanceof Error ? err.message : 'Failed to set password');
    }
    setSettingPassword(false);
  };

  const roleColors: Record<UserRole, 'success' | 'info' | 'warning'> = {
    admin: 'success',
    sales_rep: 'info',
    driver: 'warning',
    applicator: 'warning',
  };

  if (role !== 'admin') return null;

  if (pageLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SplitHeading title="App" accent="Settings" />

      <Card>
        <CardHeader
          title="Company"
          accent="Info"
          action={
            <Button
              size="sm"
              icon={<Save className="w-4 h-4" />}
              onClick={saveCompanyInfo}
              loading={savingCompany}
            >
              Save
            </Button>
          }
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Company Name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          <Input label="Phone" value={companyPhone} onChange={(e) => setCompanyPhone(e.target.value)} />
          <Input label="Email" type="email" value={companyEmail} onChange={(e) => setCompanyEmail(e.target.value)} />
          <Input label="Address" value={companyAddress} onChange={(e) => setCompanyAddress(e.target.value)} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="User"
          accent="Management"
          action={
            <Button
              size="sm"
              icon={<UserPlus className="w-4 h-4" />}
              onClick={() => setUserModalOpen(true)}
            >
              Add User
            </Button>
          }
        />
        <div className="overflow-x-auto">
          {users.length === 0 ? (
            <EmptyState
              icon={<Users className="w-6 h-6 text-gray-400" />}
              title="No users found"
              description="Add your first team member to get started."
              action={
                <Button size="sm" icon={<UserPlus className="w-4 h-4" />} onClick={() => setUserModalOpen(true)}>
                  Add User
                </Button>
              }
            />
          ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-4 py-3 text-left font-medium text-secondary">Name</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Email</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Role</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Restrictions</th>
                <th className="px-4 py-3 text-left font-medium text-secondary"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-gray-50">
                  <td className="px-4 py-3 font-medium text-nav-dark">{u.full_name}</td>
                  <td className="px-4 py-3 text-secondary">{u.email}</td>
                  <td className="px-4 py-3">
                    <Badge variant={roleColors[u.role]}>{u.role.replace('_', ' ')}</Badge>
                  </td>
                  <td className="px-4 py-3">{u.phone || '-'}</td>
                  <td className="px-4 py-3">
                    <Badge variant={u.is_active ? 'success' : 'default'}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {u.role === 'admin' ? (
                      <span className="text-xs text-gray-400">Full access</span>
                    ) : u.denied_pages?.length > 0 ? (
                      <Badge variant="warning">{u.denied_pages.length} restricted</Badge>
                    ) : (
                      <span className="text-xs text-gray-400">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Pencil className="w-3.5 h-3.5" />}
                      onClick={() => openEditModal(u)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Default"
          accent="Settings"
          action={
            <Button
              size="sm"
              icon={<Save className="w-4 h-4" />}
              onClick={saveDefaults}
              loading={savingDefaults}
            >
              Save
            </Button>
          }
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Default Quote Valid Days"
            type="number"
            min="1"
            value={defaultValidDays}
            onChange={(e) => setDefaultValidDays(e.target.value)}
          />
          {/* AR reminder threshold. NOTE: takes effect only once parked migration
              20260702162000 is applied live (get_ar_reminder_candidates reads
              app_settings.ar_reminder_days). Apply that migration before/with this deploy. */}
          <Input
            label="AR Reminder Threshold (days past due)"
            type="number"
            min="1"
            max="3650"
            value={arReminderDays}
            onChange={(e) => setArReminderDays(e.target.value)}
          />
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Default Tier</label>
            <select
              value={defaultTier}
              onChange={(e) => setDefaultTier(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="1">Tier 1</option>
              <option value="2">Tier 2</option>
              <option value="3">Tier 3</option>
            </select>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Fuel"
          accent="Surcharge"
          action={
            <Button
              size="sm"
              icon={<Save className="w-4 h-4" />}
              onClick={saveFuelSurcharge}
              loading={savingFuel}
            >
              Save
            </Button>
          }
        />
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-100 p-3">
            <Fuel className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-800">
              <strong>Off by default.</strong> A fuel surcharge is only added to
              field-application invoices when you turn it on <em>and</em> enter your own
              rate below. Leave the rate blank for no surcharge. CropRX does not set a
              rate for you &mdash; this is your billing decision.
            </p>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={fuelSurcharge.enabled}
              onChange={(e) => setFuelSurcharge((c) => ({ ...c, enabled: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
            />
            <span className="text-sm font-medium text-secondary">
              Apply a fuel surcharge to field-application invoices
            </span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Basis</label>
              <select
                value={fuelSurcharge.basis}
                onChange={(e) =>
                  setFuelSurcharge((c) => ({ ...c, basis: e.target.value as FuelSurchargeBasis }))
                }
                disabled={!fuelSurcharge.enabled}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50 disabled:text-gray-400"
              >
                <option value="">Select a basis…</option>
                <option value="per_acre">Per acre ($/acre applied)</option>
                <option value="percent">Percent of invoice (% of the bill)</option>
                <option value="flat">Flat amount ($ per invoice)</option>
              </select>
            </div>
            <Input
              label={`Rate${fuelSurcharge.basis ? ` (${fuelSurchargeRateUnit(fuelSurcharge.basis)})` : ''}`}
              type="number"
              min="0"
              step="0.01"
              placeholder="Blank = no surcharge"
              value={fuelSurcharge.rate}
              onChange={(e) => setFuelSurcharge((c) => ({ ...c, rate: e.target.value }))}
              disabled={!fuelSurcharge.enabled}
            />
          </div>

          <p className="text-xs text-secondary">
            {fuelSurchargeIsActive(fuelSurcharge) ? (
              <span className="text-amber-700 font-medium">
                Active &mdash; a &ldquo;Fuel Surcharge&rdquo; line will be added to new
                field-application invoices.
              </span>
            ) : (
              <span className="text-gray-400">
                Inert &mdash; no surcharge will be applied (off, or no rate entered).
              </span>
            )}
          </p>
        </div>
      </Card>

      {/* §4: Auto-invoice on job completion (DRAFTS ONLY — never auto-posts). */}
      <Card>
        <CardHeader
          title="Auto"
          accent="Invoice"
          action={
            <Button
              size="sm"
              icon={<Save className="w-4 h-4" />}
              onClick={saveAutoDraft}
              loading={savingAutoDraft}
            >
              Save
            </Button>
          }
        />
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-blue-50 border border-blue-100 p-3">
            <FileText className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-sm text-blue-800">
              <strong>Off by default.</strong> When on, completing a field job automatically
              creates a <strong>draft</strong> field-application invoice (using your existing
              prices and customer splits). It is <em>never</em> posted automatically &mdash;
              a draft simply lands in the &ldquo;Ready to Post&rdquo; queue on the Office
              Cockpit, where someone reviews and posts it by hand. If pricing can&rsquo;t be
              worked out, the job still completes and the office is alerted to bill it
              manually.
            </p>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoDraftEnabled}
              onChange={(e) => setAutoDraftEnabled(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
            />
            <span className="text-sm font-medium text-secondary">
              Automatically create a draft invoice when a field job is completed
            </span>
          </label>

          <p className="text-xs text-secondary">
            {autoDraftEnabled ? (
              <span className="text-blue-700 font-medium">
                On &mdash; completed jobs will auto-create a draft invoice for review (never
                auto-posted).
              </span>
            ) : (
              <span className="text-gray-400">
                Off &mdash; billing stays a manual step (transfer each completed job to an
                invoice yourself).
              </span>
            )}
          </p>
        </div>
      </Card>

      {/* §5: Label-rate guardrail mode (WARN by default — never blocks a save). */}
      <Card>
        <CardHeader
          title="Label-Rate"
          accent="Guardrail"
          action={
            <Button
              size="sm"
              icon={<Save className="w-4 h-4" />}
              onClick={saveGuardrailMode}
              loading={savingGuardrail}
            >
              Save
            </Button>
          }
        />
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-blue-50 border border-blue-100 p-3">
            <Shield className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-sm text-blue-800">
              When building a tank mix, each chemical&rsquo;s per-acre rate is checked against the
              product&rsquo;s maximum label rate, and the re-entry (REI) and pre-harvest (PHI)
              windows are shown. <strong>Warn</strong> (recommended) flags an over-label rate but
              never stops the save. <strong>Block</strong> requires an admin to override an
              over-label line with a logged reason before saving &mdash; it is still never a hard
              wall. A product with no label rate on file is never blocked.
            </p>
          </div>

          <div className="space-y-2">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="guardrail-mode"
                checked={guardrailMode === 'warn'}
                onChange={() => setGuardrailMode('warn')}
                className="w-4 h-4 mt-0.5 border-gray-300 text-crx-green focus:ring-crx-green/20"
              />
              <span className="text-sm">
                <span className="font-medium text-secondary">Warn</span>
                <span className="block text-xs text-gray-500">Flag over-label rates; the mix still saves. (Recommended default.)</span>
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="guardrail-mode"
                checked={guardrailMode === 'block'}
                onChange={() => setGuardrailMode('block')}
                className="w-4 h-4 mt-0.5 border-gray-300 text-crx-green focus:ring-crx-green/20"
              />
              <span className="text-sm">
                <span className="font-medium text-secondary">Block (admin override)</span>
                <span className="block text-xs text-gray-500">An over-label line needs an admin override with a logged reason before saving.</span>
              </span>
            </label>
          </div>
        </div>
      </Card>

      {/* #9: Custom applicator field-sheet layout (LAYOUT ONLY). */}
      <Card>
        <CardHeader
          title="Custom Applicator"
          accent="Field Sheet"
          action={
            <Button
              size="sm"
              icon={<Save className="w-4 h-4" />}
              onClick={saveSheetConfig}
              loading={savingSheet}
            >
              Save
            </Button>
          }
        />
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-green-50 border border-green-100 p-3">
            <ClipboardList className="w-5 h-5 text-crx-green mt-0.5 shrink-0" />
            <p className="text-sm text-green-800">
              <strong>Layout only.</strong> These settings change how the
              &ldquo;Custom Applicator Report&rdquo; field sheet looks &mdash; the company
              header, logo, footer, and which optional columns appear. They never
              change any chemical, rate, acre, or billing figure. Leave fields blank to
              use the standard CropRX header.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Company Name (header)"
              placeholder="Blank = Crop RX Solutions"
              value={sheetConfig.company_name}
              onChange={(e) => setSheetConfig((c) => ({ ...c, company_name: e.target.value }))}
            />
            <Input
              label="Company Address (header)"
              placeholder="Blank = West York, IL"
              value={sheetConfig.company_address}
              onChange={(e) => setSheetConfig((c) => ({ ...c, company_address: e.target.value }))}
            />
          </div>

          <Input
            label="Footer Text (optional)"
            placeholder="An extra line under the standard footer"
            value={sheetConfig.footer_text}
            onChange={(e) => setSheetConfig((c) => ({ ...c, footer_text: e.target.value }))}
          />

          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Header Logo (optional)</label>
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 500 * 1024) {
                    toast('error', 'Logo must be under 500 KB');
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => setSheetConfig((c) => ({ ...c, logo_data_url: typeof reader.result === 'string' ? reader.result : '' }));
                  reader.readAsDataURL(file);
                }}
                className="text-sm"
              />
              {sheetConfig.logo_data_url && (
                <Button size="sm" variant="secondary" onClick={() => setSheetConfig((c) => ({ ...c, logo_data_url: '' }))}>
                  Remove
                </Button>
              )}
            </div>
            {sheetConfig.logo_data_url && (
              <img src={sheetConfig.logo_data_url} alt="Logo preview" className="mt-2 h-10 object-contain" />
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-secondary mb-2">Optional columns on the Custom sheet</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {([
                ['crop', 'Crop'],
                ['pest', 'Pest'],
                ['total_applied', 'Total Applied'],
                ['gl_lb', 'gal/lb Equivalent'],
                ['rei', 'REI'],
                ['phi', 'PHI'],
              ] as [keyof ApplicatorSheetCustomConfig['columns'], string][]).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sheetConfig.columns[key]}
                    onChange={() => toggleSheetColumn(key)}
                    className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
                  />
                  <span className="text-sm text-secondary">{label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* #40: editable pre-application customer notice wording (subject + body). */}
      <Card>
        <CardHeader
          title="Pre-Application"
          accent="Customer Notice"
          action={
            <Button
              size="sm"
              icon={<Save className="w-4 h-4" />}
              onClick={savePreNoticeTemplate}
              loading={savingPreNotice}
            >
              Save
            </Button>
          }
        />
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-green-50 border border-green-100 p-3">
            <Bell className="w-5 h-5 text-crx-green mt-0.5 shrink-0" />
            <p className="text-sm text-green-800">
              The message emailed to a customer when you click <strong>Send Pre-Notification</strong> on
              a job. Use <code>{'{{customer}}'}</code>, <code>{'{{job_number}}'}</code> and{' '}
              <code>{'{{job_date}}'}</code> as placeholders &mdash; they are filled in per recipient.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Subject</label>
            <Input
              value={preNoticeTemplate.subject}
              onChange={(e) => setPreNoticeTemplate((t) => ({ ...t, subject: e.target.value }))}
              placeholder="Upcoming application on your fields"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Message</label>
            <textarea
              value={preNoticeTemplate.body}
              onChange={(e) => setPreNoticeTemplate((t) => ({ ...t, body: e.target.value }))}
              rows={8}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-y"
              placeholder="Hello {{customer}}, ..."
            />
          </div>
        </div>
      </Card>

      {/* #41: editable post-application customer notice wording (subject + body). */}
      <Card>
        <CardHeader
          title="Post-Application"
          accent="Customer Notice"
          action={
            <Button
              size="sm"
              icon={<Save className="w-4 h-4" />}
              onClick={savePostNoticeTemplate}
              loading={savingPostNotice}
            >
              Save
            </Button>
          }
        />
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-green-50 border border-green-100 p-3">
            <Bell className="w-5 h-5 text-crx-green mt-0.5 shrink-0" />
            <p className="text-sm text-green-800">
              The message emailed to a customer when you click <strong>Send Post-Notification</strong> on
              a completed job or its field-application invoice. Use <code>{'{{customer}}'}</code>,{' '}
              <code>{'{{job_number}}'}</code> and <code>{'{{job_date}}'}</code> as placeholders &mdash;
              they are filled in per recipient.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Subject</label>
            <Input
              value={postNoticeTemplate.subject}
              onChange={(e) => setPostNoticeTemplate((t) => ({ ...t, subject: e.target.value }))}
              placeholder="Your field application is complete"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Message</label>
            <textarea
              value={postNoticeTemplate.body}
              onChange={(e) => setPostNoticeTemplate((t) => ({ ...t, body: e.target.value }))}
              rows={8}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-y"
              placeholder="Hello {{customer}}, ..."
            />
          </div>
        </div>
      </Card>

      <Modal open={userModalOpen} onClose={() => setUserModalOpen(false)} title="Add" accent="User">
        <div className="space-y-4">
          <Input label="Full Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Input label="Email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          <Input label="Password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 6 characters" />
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Role</label>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="admin">Admin</option>
              <option value="sales_rep">Sales Rep</option>
              <option value="driver">Driver</option>
              <option value="applicator">Applicator</option>
            </select>
          </div>
          <Input label="Phone" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setUserModalOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateUser} loading={creatingUser}>Create User</Button>
          </div>
        </div>
      </Modal>

      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit" accent="User" size="large">
        <div className="space-y-4">
          {editingUser && (
            <p className="text-sm text-secondary">{editingUser.email}</p>
          )}
          <Input label="Full Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Role</label>
            <select
              value={editRole}
              onChange={(e) => handleEditRoleChange(e.target.value as UserRole)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="admin">Admin</option>
              <option value="sales_rep">Sales Rep</option>
              <option value="driver">Driver</option>
              <option value="applicator">Applicator</option>
            </select>
          </div>
          <Input label="Phone" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={editIsActive}
                onChange={(e) => setEditIsActive(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
              />
              <span className="text-sm font-medium text-secondary">Active</span>
            </label>
          </div>

          <UserPermissionsPanel
            role={editRole}
            deniedPages={editDeniedPages}
            onChange={setEditDeniedPages}
          />

          <div className="flex items-center justify-between pt-2">
            <div>
              {editingUser && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<KeyRound className="w-3.5 h-3.5" />}
                  onClick={() => { setEditModalOpen(false); openPasswordModal(editingUser); }}
                >
                  Set Password
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setEditModalOpen(false)}>Cancel</Button>
              <Button onClick={handleEditUser} loading={savingUser}>Save Changes</Button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={deactivateConfirmOpen}
        onClose={() => setDeactivateConfirmOpen(false)}
        onConfirm={executeEditUser}
        title="Deactivate User"
        message={`Deactivate ${editName}? They will be signed out of any open sessions and blocked from signing in again. Reactivating them restores access.`}
        confirmLabel="Deactivate"
        variant="warning"
      />

      <Modal open={passwordModalOpen} onClose={() => setPasswordModalOpen(false)} title="Set" accent="Password">
        <div className="space-y-4">
          {passwordTarget && (
            <p className="text-sm text-secondary">
              Setting a new password for <strong>{passwordTarget.full_name}</strong> ({passwordTarget.email})
            </p>
          )}
          <Input
            label="New Password"
            type="password"
            value={adminSetPassword}
            onChange={(e) => setAdminSetPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
          <Input
            label="Confirm Password"
            type="password"
            value={adminConfirmPassword}
            onChange={(e) => setAdminConfirmPassword(e.target.value)}
            placeholder="Re-enter the password"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setPasswordModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSetPassword} loading={settingPassword}>Update Password</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
