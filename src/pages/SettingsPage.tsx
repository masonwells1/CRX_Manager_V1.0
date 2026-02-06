import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, UserPlus } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import type { Profile, AppSetting, UserRole } from '../types';

export default function SettingsPage() {
  const { role } = useAuth();
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
    const { data: existing } = await supabase
      .from('app_settings')
      .select('id')
      .eq('setting_key', key)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('app_settings')
        .update({ setting_value: value, updated_at: new Date().toISOString() })
        .eq('setting_key', key);
    } else {
      await supabase
        .from('app_settings')
        .insert({ setting_key: key, setting_value: value });
    }
  };

  const saveCompanyInfo = async () => {
    setSavingCompany(true);
    await Promise.all([
      saveSetting('company_name', companyName),
      saveSetting('company_phone', companyPhone),
      saveSetting('company_email', companyEmail),
      saveSetting('company_address', companyAddress),
    ]);
    toast('success', 'Company info saved');
    setSavingCompany(false);
  };

  const saveDefaults = async () => {
    setSavingDefaults(true);
    await Promise.all([
      saveSetting('default_quote_valid_days', defaultValidDays),
      saveSetting('default_tier', defaultTier),
    ]);
    toast('success', 'Default settings saved');
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
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-user`;
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: newEmail,
          password: newPassword,
          full_name: newName,
          role: newRole,
          phone: newPhone || null,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        toast('error', result.error || 'Failed to create user');
      } else {
        toast('success', 'User created successfully');
        setUserModalOpen(false);
        setNewEmail('');
        setNewName('');
        setNewPassword('');
        setNewRole('sales_rep');
        setNewPhone('');
        fetchUsers();
      }
    } catch {
      toast('error', 'Failed to create user');
    }
    setCreatingUser(false);
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
    </div>
  );
}
