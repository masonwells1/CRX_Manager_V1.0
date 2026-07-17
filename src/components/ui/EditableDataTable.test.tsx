import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import EditableDataTable from './EditableDataTable';
import type { EditableColumn } from './EditableDataTable';

// ── Test data fixtures ──────────────────────────────────────────────
interface TestProduct extends Record<string, unknown> {
  id: string;
  name: string;
  price: number;
  category: string;
  active: boolean;
}

const testData: TestProduct[] = [
  { id: '1', name: 'Product A', price: 1000, category: 'Seeds', active: true },
  { id: '2', name: 'Product B', price: 2500, category: 'Chemical', active: false },
  { id: '3', name: 'Product C', price: 500, category: 'Seeds', active: true },
];

const columns: EditableColumn<TestProduct>[] = [
  { key: 'name', header: 'Name', sortable: true, editable: true, editType: 'text' as const },
  { key: 'price', header: 'Price', sortable: true, editable: true, editType: 'number' as const, editMin: 0 },
  {
    key: 'category',
    header: 'Category',
    sortable: true,
    editable: true,
    editType: 'select' as const,
    editOptions: [
      { value: 'Seeds', label: 'Seeds' },
      { value: 'Chemical', label: 'Chemical' },
    ],
  },
  { key: 'active', header: 'Active', editable: true, editType: 'toggle' as const },
];

// ── 1. Rendering ────────────────────────────────────────────────────
describe('EditableDataTable', () => {
  describe('Rendering', () => {
    it('renders table with column headers', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" />);
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Price')).toBeInTheDocument();
      expect(screen.getByText('Category')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('renders all data rows', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" />);
      expect(screen.getByText('Product A')).toBeInTheDocument();
      expect(screen.getByText('Product B')).toBeInTheDocument();
      expect(screen.getByText('Product C')).toBeInTheDocument();
    });

    it('renders empty state when data is empty', () => {
      render(<EditableDataTable data={[]} columns={columns} rowKey="id" />);
      expect(screen.getByText('No data found')).toBeInTheDocument();
    });

    it('renders custom empty title and description', () => {
      render(
        <EditableDataTable
          data={[]}
          columns={columns}
          rowKey="id"
          emptyTitle="Nothing here"
          emptyDescription="Try adding some items"
        />
      );
      expect(screen.getByText('Nothing here')).toBeInTheDocument();
      expect(screen.getByText('Try adding some items')).toBeInTheDocument();
    });

    it('shows loading skeleton when loading=true', () => {
      const { container } = render(
        <EditableDataTable data={testData} columns={columns} rowKey="id" loading />
      );
      const pulses = container.querySelectorAll('.animate-pulse');
      expect(pulses.length).toBe(5);
      // Data should NOT render while loading
      expect(screen.queryByText('Product A')).not.toBeInTheDocument();
    });
  });

  // ── 2. Search ───────────────────────────────────────────────────────
  describe('Search', () => {
    it('shows search input when searchable=true', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          searchable
          searchKeys={['name']}
        />
      );
      expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
    });

    it('does not show search input when searchable is false', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" />);
      expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
    });

    it('filters rows by search text across searchKeys', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          searchable
          searchKeys={['name', 'category']}
        />
      );
      fireEvent.change(screen.getByPlaceholderText('Search...'), {
        target: { value: 'Product A' },
      });
      expect(screen.getByText('Product A')).toBeInTheDocument();
      expect(screen.queryByText('Product B')).not.toBeInTheDocument();
      expect(screen.queryByText('Product C')).not.toBeInTheDocument();
    });

    it('performs case-insensitive search', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          searchable
          searchKeys={['name']}
        />
      );
      fireEvent.change(screen.getByPlaceholderText('Search...'), {
        target: { value: 'product b' },
      });
      expect(screen.getByText('Product B')).toBeInTheDocument();
      expect(screen.queryByText('Product A')).not.toBeInTheDocument();
    });

    it('shows all rows when search is cleared', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          searchable
          searchKeys={['name']}
        />
      );
      const input = screen.getByPlaceholderText('Search...');
      fireEvent.change(input, { target: { value: 'Product A' } });
      expect(screen.queryByText('Product B')).not.toBeInTheDocument();

      fireEvent.change(input, { target: { value: '' } });
      expect(screen.getByText('Product A')).toBeInTheDocument();
      expect(screen.getByText('Product B')).toBeInTheDocument();
      expect(screen.getByText('Product C')).toBeInTheDocument();
    });
  });

  // ── 3. Sorting ──────────────────────────────────────────────────────
  describe('Sorting', () => {
    it('clicking sortable column sorts ascending', () => {
      const { container } = render(
        <EditableDataTable data={testData} columns={columns} rowKey="id" />
      );
      fireEvent.click(screen.getByText('Name'));
      const rows = container.querySelectorAll('tbody tr');
      expect(rows[0]).toHaveTextContent('Product A');
      expect(rows[1]).toHaveTextContent('Product B');
      expect(rows[2]).toHaveTextContent('Product C');
    });

    it('clicking sortable column twice sorts descending', () => {
      const { container } = render(
        <EditableDataTable data={testData} columns={columns} rowKey="id" />
      );
      fireEvent.click(screen.getByText('Name'));
      fireEvent.click(screen.getByText('Name'));
      const rows = container.querySelectorAll('tbody tr');
      expect(rows[0]).toHaveTextContent('Product C');
      expect(rows[1]).toHaveTextContent('Product B');
      expect(rows[2]).toHaveTextContent('Product A');
    });

    it('non-sortable columns do not have a sort button', () => {
      const nonSortableColumns: EditableColumn<TestProduct>[] = [
        { key: 'name', header: 'Name', sortable: false },
        { key: 'price', header: 'Price', sortable: true },
      ];
      render(<EditableDataTable data={testData} columns={nonSortableColumns} rowKey="id" />);
      // "Name" is rendered as plain text, not inside a button
      const nameHeader = screen.getByText('Name');
      expect(nameHeader.tagName).not.toBe('BUTTON');
      expect(nameHeader.closest('button')).toBeNull();
    });

    it('numeric sort works correctly', () => {
      const { container } = render(
        <EditableDataTable data={testData} columns={columns} rowKey="id" />
      );
      fireEvent.click(screen.getByText('Price'));
      const rows = container.querySelectorAll('tbody tr');
      // ascending: 500, 1000, 2500
      expect(within(rows[0] as HTMLElement).getByText('500')).toBeInTheDocument();
      expect(within(rows[1] as HTMLElement).getByText('1000')).toBeInTheDocument();
      expect(within(rows[2] as HTMLElement).getByText('2500')).toBeInTheDocument();
    });

    it('null values sort to end', () => {
      const dataWithNull = [
        { id: '1', name: 'Alpha', price: 100, category: 'Seeds', active: true },
        { id: '2', name: null as unknown as string, price: 200, category: 'Chemical', active: true },
        { id: '3', name: 'Beta', price: 300, category: 'Seeds', active: false },
      ];
      const { container } = render(
        <EditableDataTable data={dataWithNull} columns={columns} rowKey="id" />
      );
      fireEvent.click(screen.getByText('Name'));
      const rows = container.querySelectorAll('tbody tr');
      // null sorts to end: Alpha, Beta, null
      expect(rows[0]).toHaveTextContent('Alpha');
      expect(rows[1]).toHaveTextContent('Beta');
      // Last row has the null name (rendered as '-')
      expect(within(rows[2] as HTMLElement).getByText('-')).toBeInTheDocument();
    });
  });

  // ── 4. Row Click ────────────────────────────────────────────────────
  describe('Row Click', () => {
    it('calls onRowClick when clicking a row', () => {
      const onClick = vi.fn();
      render(
        <EditableDataTable data={testData} columns={columns} rowKey="id" onRowClick={onClick} />
      );
      fireEvent.click(screen.getByText('Product A'));
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledWith(testData[0]);
    });

    it('does not call onRowClick in edit mode', () => {
      const onClick = vi.fn();
      const { container } = render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          onRowClick={onClick}
          canEdit
        />
      );
      // Enter edit mode
      fireEvent.click(screen.getByText('Edit'));
      // In edit mode, text cells become inputs, so click the row element directly
      const firstRow = container.querySelector('tbody tr')!;
      fireEvent.click(firstRow);
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  // ── 5. Edit Mode ────────────────────────────────────────────────────
  describe('Edit Mode', () => {
    it('shows Edit button when canEdit=true', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" canEdit />);
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });

    it('hides Edit button when canEdit is false', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" canEdit={false} />);
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    });

    it('hides Edit button when canEdit is not provided', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" />);
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    });

    it('clicking Edit enters edit mode and shows Cancel and Save', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" canEdit />);
      fireEvent.click(screen.getByText('Edit'));
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText('Save')).toBeInTheDocument();
      // Edit button should be gone
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    });

    it('text inputs appear for editable text columns in edit mode', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" canEdit />);
      fireEvent.click(screen.getByText('Edit'));
      // All three rows should have text inputs for the name column
      const textInputs = screen.getAllByDisplayValue('Product A');
      expect(textInputs.length).toBe(1);
      expect(textInputs[0].tagName).toBe('INPUT');
      expect(textInputs[0]).toHaveAttribute('type', 'text');
    });

    it('number inputs appear for editable number columns in edit mode', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" canEdit />);
      fireEvent.click(screen.getByText('Edit'));
      const numInputs = screen.getAllByDisplayValue('1000');
      expect(numInputs.length).toBe(1);
      expect(numInputs[0]).toHaveAttribute('type', 'number');
    });

    it('select inputs appear for editable select columns in edit mode', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" canEdit />);
      fireEvent.click(screen.getByText('Edit'));
      const selects = screen.getAllByRole('combobox');
      expect(selects.length).toBe(3); // one select per row
    });

    it('gives built-in select editors row-specific accessible names', () => {
      const accessibleColumns = columns.map((column) => column.key === 'category'
        ? { ...column, editAriaLabel: (row: TestProduct) => `Category for ${row.name}` }
        : column);
      render(<EditableDataTable data={testData} columns={accessibleColumns} rowKey="id" canEdit />);
      fireEvent.click(screen.getByText('Edit'));
      expect(screen.getByRole('combobox', { name: 'Category for Product A' })).toBeInTheDocument();
    });

    it('toggle (checkbox) inputs appear for editable toggle columns in edit mode', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" canEdit />);
      fireEvent.click(screen.getByText('Edit'));
      const checkboxes = screen.getAllByRole('checkbox');
      // 3 rows, each with a toggle column
      expect(checkboxes.length).toBe(3);
      // Product A is active=true
      expect(checkboxes[0]).toBeChecked();
      // Product B is active=false
      expect(checkboxes[1]).not.toBeChecked();
    });

    it('Cancel button exits edit mode and returns to normal view', () => {
      render(<EditableDataTable data={testData} columns={columns} rowKey="id" canEdit />);
      fireEvent.click(screen.getByText('Edit'));
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Cancel'));
      // Back to normal mode
      expect(screen.getByText('Edit')).toBeInTheDocument();
      expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
      // Text inputs should be gone, plain text should be back
      expect(screen.getByText('Product A')).toBeInTheDocument();
    });

    it('Save button is disabled when there are no dirty rows', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={vi.fn()}
        />
      );
      fireEvent.click(screen.getByText('Edit'));
      const saveBtn = screen.getByText('Save');
      expect(saveBtn.closest('button')).toBeDisabled();
    });

    it('calls onSave with dirty changes Map when Save is clicked', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByText('Edit'));

      // Change a text input
      const nameInput = screen.getByDisplayValue('Product A');
      fireEvent.change(nameInput, { target: { value: 'Product A Modified' } });

      // Save
      const saveBtn = screen.getByText(/Save/);
      fireEvent.click(saveBtn.closest('button')!);

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1);
      });

      const changesMap = onSave.mock.calls[0][0] as Map<string, Record<string, unknown>>;
      expect(changesMap).toBeInstanceOf(Map);
      expect(changesMap.get('1')).toEqual({ name: 'Product A Modified' });
    });

    it('exits edit mode after successful save', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByText('Edit'));
      const nameInput = screen.getByDisplayValue('Product A');
      fireEvent.change(nameInput, { target: { value: 'Changed' } });
      fireEvent.click(screen.getByText(/Save/).closest('button')!);

      await waitFor(() => {
        expect(screen.getByText('Edit')).toBeInTheDocument();
      });
    });

    it('exits edit mode when onSave explicitly returns true', async () => {
      const onSave = vi.fn().mockResolvedValue(true);
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByText('Edit'));
      fireEvent.change(screen.getByDisplayValue('Product A'), {
        target: { value: 'Changed' },
      });
      fireEvent.click(screen.getByText(/Save/).closest('button')!);

      await waitFor(() => {
        expect(screen.getByText('Edit')).toBeInTheDocument();
      });
      expect(screen.queryByDisplayValue('Changed')).not.toBeInTheDocument();
    });

    it('keeps edit mode and dirty rows when onSave returns false', async () => {
      const onSave = vi.fn().mockResolvedValue(false);
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByText('Edit'));
      fireEvent.change(screen.getByDisplayValue('Product A'), {
        target: { value: 'Changed' },
      });
      fireEvent.click(screen.getByText(/Save/).closest('button')!);

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1);
      });
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Changed')).toBeInTheDocument();
      expect(screen.getByText('Save (1)')).toBeInTheDocument();
    });
  });

  // ── 6. Dirty Tracking ──────────────────────────────────────────────
  describe('Dirty Tracking', () => {
    it('changing a cell value adds to dirty rows and shows count on Save button', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={vi.fn()}
        />
      );
      fireEvent.click(screen.getByText('Edit'));

      // Change Product A name
      const nameInput = screen.getByDisplayValue('Product A');
      fireEvent.change(nameInput, { target: { value: 'Changed A' } });

      expect(screen.getByText(/Save \(1\)/)).toBeInTheDocument();
    });

    it('multiple changes on the same row are merged', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByText('Edit'));

      // Change name of Product A
      const nameInput = screen.getByDisplayValue('Product A');
      fireEvent.change(nameInput, { target: { value: 'New Name' } });

      // Change price of Product A
      const priceInput = screen.getByDisplayValue('1000');
      fireEvent.change(priceInput, { target: { value: '999' } });

      // Still one dirty row
      expect(screen.getByText(/Save \(1\)/)).toBeInTheDocument();

      // Save and check merged changes
      fireEvent.click(screen.getByText(/Save/).closest('button')!);

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1);
      });
      const changesMap = onSave.mock.calls[0][0] as Map<string, Record<string, unknown>>;
      expect(changesMap.get('1')).toEqual({ name: 'New Name', price: 999 });
    });

    it('shows correct dirty count for multiple rows', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={vi.fn()}
        />
      );
      fireEvent.click(screen.getByText('Edit'));

      // Change Product A
      fireEvent.change(screen.getByDisplayValue('Product A'), {
        target: { value: 'Changed A' },
      });
      // Change Product B
      fireEvent.change(screen.getByDisplayValue('Product B'), {
        target: { value: 'Changed B' },
      });

      expect(screen.getByText(/Save \(2\)/)).toBeInTheDocument();
    });

    it('reverting a value to original removes it from dirty tracking', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={vi.fn()}
        />
      );
      fireEvent.click(screen.getByText('Edit'));

      const nameInput = screen.getByDisplayValue('Product A');
      // Change it
      fireEvent.change(nameInput, { target: { value: 'Changed' } });
      expect(screen.getByText(/Save \(1\)/)).toBeInTheDocument();

      // Revert to original
      fireEvent.change(screen.getByDisplayValue('Changed'), {
        target: { value: 'Product A' },
      });
      // Save should have no count (disabled)
      expect(screen.getByText('Save')).toBeInTheDocument();
      expect(screen.queryByText(/Save \(\d+\)/)).not.toBeInTheDocument();
    });

    it('Cancel clears all dirty state', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          canEdit
          onSave={vi.fn()}
        />
      );
      fireEvent.click(screen.getByText('Edit'));
      fireEvent.change(screen.getByDisplayValue('Product A'), {
        target: { value: 'Changed' },
      });
      expect(screen.getByText(/Save \(1\)/)).toBeInTheDocument();

      fireEvent.click(screen.getByText('Cancel'));
      // Re-enter edit mode
      fireEvent.click(screen.getByText('Edit'));
      // Save should be clean (no dirty count)
      expect(screen.getByText('Save')).toBeInTheDocument();
      expect(screen.queryByText(/Save \(\d+\)/)).not.toBeInTheDocument();
    });
  });

  // ── 7. Header Actions ──────────────────────────────────────────────
  describe('Header Actions', () => {
    it('renders headerActions content', () => {
      render(
        <EditableDataTable
          data={testData}
          columns={columns}
          rowKey="id"
          headerActions={<button data-testid="custom-action">Export</button>}
        />
      );
      expect(screen.getByTestId('custom-action')).toBeInTheDocument();
    });
  });

  // ── 8. editRender ─────────────────────────────────────────────────
  describe('editRender', () => {
    it('shows editRender content in edit mode, not in view mode', () => {
      const customColumns: EditableColumn<TestProduct>[] = [
        { key: 'name', header: 'Name' },
        {
          key: 'price',
          header: 'Price',
          editable: true,
          render: (row) => <span>${row.price}</span>,
          editRender: (_row, _get, _set) => (
            <div data-testid="custom-edit-cell">Custom editor</div>
          ),
        },
      ];
      const { rerender } = render(
        <EditableDataTable data={testData} columns={customColumns} rowKey="id" canEdit />
      );
      // View mode: editRender NOT shown
      expect(screen.queryByTestId('custom-edit-cell')).not.toBeInTheDocument();
      expect(screen.getByText('$1000')).toBeInTheDocument();

      // Enter edit mode
      fireEvent.click(screen.getByText('Edit'));
      // editRender IS shown
      expect(screen.getAllByTestId('custom-edit-cell').length).toBe(3);
      // Normal render is NOT shown
      expect(screen.queryByText('$1000')).not.toBeInTheDocument();

      // Cancel edit mode: editRender gone again
      fireEvent.click(screen.getByText('Cancel'));
      rerender(
        <EditableDataTable data={testData} columns={customColumns} rowKey="id" canEdit />
      );
      expect(screen.queryByTestId('custom-edit-cell')).not.toBeInTheDocument();
    });

    it('getCellValue reflects dirty state from sibling columns', () => {
      const customColumns: EditableColumn<TestProduct>[] = [
        {
          key: 'name',
          header: 'Name',
          editable: true,
          editType: 'text',
        },
        {
          key: 'price',
          header: 'Price',
          editable: true,
          editRender: (_row, getCellValue, _setCellValue) => {
            const name = getCellValue('name');
            return <span data-testid="price-cell">name={String(name)}</span>;
          },
        },
      ];
      render(
        <EditableDataTable
          data={testData}
          columns={customColumns}
          rowKey="id"
          canEdit
          onSave={vi.fn()}
        />
      );
      fireEvent.click(screen.getByText('Edit'));

      // Before any edits, getCellValue reads original
      const cells = screen.getAllByTestId('price-cell');
      expect(cells[0]).toHaveTextContent('name=Product A');

      // Edit sibling column (name)
      const nameInput = screen.getByDisplayValue('Product A');
      fireEvent.change(nameInput, { target: { value: 'Dirty Name' } });

      // getCellValue now returns dirty value
      const updatedCells = screen.getAllByTestId('price-cell');
      expect(updatedCells[0]).toHaveTextContent('name=Dirty Name');
    });

    it('setCellValue marks row dirty and increments Save count', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const customColumns: EditableColumn<TestProduct>[] = [
        { key: 'name', header: 'Name' },
        {
          key: 'price',
          header: 'Price',
          editable: true,
          editRender: (row, _get, setCellValue) => (
            <button
              data-testid={`set-price-${row.id}`}
              onClick={() => setCellValue('price', 9999)}
            >
              Set price
            </button>
          ),
        },
      ];
      render(
        <EditableDataTable
          data={testData}
          columns={customColumns}
          rowKey="id"
          canEdit
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByText('Edit'));

      // Save disabled (no dirty rows)
      expect(screen.getByText('Save').closest('button')).toBeDisabled();

      // Click custom setCellValue button for row 1
      fireEvent.click(screen.getByTestId('set-price-1'));

      // Save count updated
      expect(screen.getByText(/Save \(1\)/)).toBeInTheDocument();

      // Save and verify the dirty data
      fireEvent.click(screen.getByText(/Save/).closest('button')!);
      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1);
      });
      const changesMap = onSave.mock.calls[0][0] as Map<string, Record<string, unknown>>;
      expect(changesMap.get('1')).toEqual({ price: 9999 });
    });
  });
});
