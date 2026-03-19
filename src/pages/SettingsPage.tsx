import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, UserPlus, Pencil, Shield, Users, KeyRound } from 'lucide-react';
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
  const [defaultTier, setDefaultTier] = useState('1');
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
    setDefaultTier(map['default_tier'] || '1');
  };

  const fetchUsers = async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
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
    try {
      await Promise.all([
        saveSetting('default_quote_valid_days', defaultValidDays),
        saveSetting('default_tier', defaultTier),
      ]);
      toast('success', 'Default settings saved');
      if (profile) logActivity({ event: 'settings_updated', description: 'Default settings updated', performedBy: profile.id });
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSavingDefaults(false);
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
        new_phone: editPhone || null,
        new_is_active: editIsActive,
        new_denied_pages: editRole === 'admin' ? [] : editDeniedPages,
        p_idempotency_key: idemKey,
      });
      if (error) {
        toast('error', sanitizeError(error));
      } else {
        assertRpcResult(data, 'admin_update_profile');
        if (data?.error) {
          toast('error', data.error);
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
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/reset-user-password`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
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
        message={`Deactivate ${editName}? They will be locked out and unable to sign in.`}
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
