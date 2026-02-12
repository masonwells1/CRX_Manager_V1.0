import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, UserPlus, Pencil } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { logActivity } from '../lib/activityLogger';
import { supabase, checkMutationResult } from '../lib/db';
import type { Profile, AppSetting, UserRole } from '../types';

export default function SettingsPage() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

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
  const [savingUser, setSavingUser] = useState(false);

  useEffect(() => {
    if (role !== 'admin') {
      navigate('/');
      return;
    }
    fetchSettings();
    fetchUsers();
  }, [role]);

  const fetchSettings = async () => {
    const { data } = await supabase.from('app_settings').select('*');
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
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .order('full_name');
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
      if (profile) logActivity('settings_updated', 'Company info updated', profile.id);
    } catch (err: any) {
      toast('error', err.message || 'Failed to save company info');
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
      if (profile) logActivity('settings_updated', 'Default settings updated', profile.id);
    } catch (err: any) {
      toast('error', err.message || 'Failed to save default settings');
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
        if (profile) logActivity('user_created', `User ${newName} (${newRole}) created`, profile.id);
        setUserModalOpen(false);
        setNewEmail('');
        setNewName('');
        setNewPassword('');
        setNewRole('sales_rep');
        setNewPhone('');
        fetchUsers();
      }
    } catch (err) {
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
    setEditModalOpen(true);
  };

  const handleEditUser = async () => {
    if (!editingUser) return;
    if (editIsActive === false && !confirm('Deactivate this user? They will be locked out.')) return;
    setSavingUser(true);
    try {
      const { data, error } = await supabase.rpc('admin_update_profile', {
        target_user_id: editingUser.id,
        new_role: editRole,
        new_full_name: editName,
        new_phone: editPhone || null,
        new_is_active: editIsActive,
      });
      if (error) {
        toast('error', error.message || 'Failed to update user');
      } else if (data?.error) {
        toast('error', data.error);
      } else {
        toast('success', 'User updated successfully');
        if (profile) logActivity('user_updated', `User ${editName} updated (role: ${editRole}, active: ${editIsActive})`, profile.id);
        setEditModalOpen(false);
        setEditingUser(null);
        fetchUsers();
      }
    } catch {
      toast('error', 'Failed to update user');
    }
    setSavingUser(false);
  };

  const roleColors: Record<UserRole, 'success' | 'info' | 'warning'> = {
    admin: 'success',
    sales_rep: 'info',
    driver: 'warning',
  };

  if (role !== 'admin') return null;

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
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-4 py-3 text-left font-medium text-secondary">Name</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Email</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Role</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
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
            </select>
          </div>
          <Input label="Phone" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setUserModalOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateUser} loading={creatingUser}>Create User</Button>
          </div>
        </div>
      </Modal>

      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit" accent="User">
        <div className="space-y-4">
          {editingUser && (
            <p className="text-sm text-secondary">{editingUser.email}</p>
          )}
          <Input label="Full Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Role</label>
            <select
              value={editRole}
              onChange={(e) => setEditRole(e.target.value as UserRole)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="admin">Admin</option>
              <option value="sales_rep">Sales Rep</option>
              <option value="driver">Driver</option>
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
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setEditModalOpen(false)}>Cancel</Button>
            <Button onClick={handleEditUser} loading={savingUser}>Save Changes</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
