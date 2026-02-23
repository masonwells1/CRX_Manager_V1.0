import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DataTable, { type Column } from './DataTable';

interface TestRow {
  id: number;
  name: string;
  age: number;
  email: string;
}

const columns: Column<TestRow>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'age', header: 'Age', sortable: true },
  { key: 'email', header: 'Email' },
];

const data: TestRow[] = [
  { id: 1, name: 'Alice', age: 30, email: 'alice@test.com' },
  { id: 2, name: 'Bob', age: 25, email: 'bob@test.com' },
  { id: 3, name: 'Charlie', age: 35, email: 'charlie@test.com' },
];

describe('DataTable', () => {
  it('renders column headers', () => {
    render(<DataTable data={data} columns={columns} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Age')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('renders data rows', () => {
    render(<DataTable data={data} columns={columns} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
  });

  it('renders cell values from data', () => {
    render(<DataTable data={data} columns={columns} />);
    expect(screen.getByText('alice@test.com')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('shows empty state when data is empty', () => {
    render(
      <DataTable
        data={[]}
        columns={columns}
        emptyTitle="Nothing here"
        emptyDescription="Add some data"
      />
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Add some data')).toBeInTheDocument();
  });

  it('shows default empty title when no custom one provided', () => {
    render(<DataTable data={[]} columns={columns} />);
    expect(screen.getByText('No data found')).toBeInTheDocument();
  });

  it('shows loading skeletons when loading', () => {
    const { container } = render(
      <DataTable data={data} columns={columns} loading />
    );
    const pulseElements = container.querySelectorAll('.animate-pulse');
    expect(pulseElements.length).toBe(5); // 5 loading rows
  });

  // Search
  it('renders search input when searchable', () => {
    render(
      <DataTable
        data={data}
        columns={columns}
        searchable
        searchKeys={['name']}
      />
    );
    expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
  });

  it('filters rows by search text', () => {
    render(
      <DataTable
        data={data}
        columns={columns}
        searchable
        searchKeys={['name']}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'ali' },
    });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    expect(screen.queryByText('Charlie')).not.toBeInTheDocument();
  });

  it('uses custom search placeholder', () => {
    render(
      <DataTable
        data={data}
        columns={columns}
        searchable
        searchPlaceholder="Find customers..."
      />
    );
    expect(screen.getByPlaceholderText('Find customers...')).toBeInTheDocument();
  });

  // Sort
  it('sorts ascending when sortable column header is clicked', () => {
    render(<DataTable data={data} columns={columns} />);

    // Click Age header to sort ascending
    const ageButton = screen.getByLabelText(/Sort by Age/);
    fireEvent.click(ageButton);

    const cells = screen.getAllByRole('cell');
    // Find age cells (index 1, 4, 7 in a 3-column table)
    const ageCells = cells.filter((_, i) => i % 3 === 1);
    expect(ageCells[0].textContent).toBe('25'); // Bob
    expect(ageCells[1].textContent).toBe('30'); // Alice
    expect(ageCells[2].textContent).toBe('35'); // Charlie
  });

  it('sorts descending when same column header is clicked again', () => {
    render(<DataTable data={data} columns={columns} />);

    const ageButton = screen.getByLabelText(/Sort by Age/);
    fireEvent.click(ageButton); // asc
    fireEvent.click(ageButton); // desc

    const cells = screen.getAllByRole('cell');
    const ageCells = cells.filter((_, i) => i % 3 === 1);
    expect(ageCells[0].textContent).toBe('35'); // Charlie
    expect(ageCells[1].textContent).toBe('30'); // Alice
    expect(ageCells[2].textContent).toBe('25'); // Bob
  });

  // Row click
  it('calls onRowClick when a row is clicked', () => {
    const onRowClick = vi.fn();
    render(
      <DataTable data={data} columns={columns} onRowClick={onRowClick} />
    );

    fireEvent.click(screen.getByText('Alice'));
    expect(onRowClick).toHaveBeenCalledWith(data[0]);
  });

  it('makes rows keyboard-accessible when onRowClick is provided', () => {
    const onRowClick = vi.fn();
    render(
      <DataTable data={data} columns={columns} onRowClick={onRowClick} />
    );

    // Each row (<tr>) gets role="button" and tabIndex=0
    const tableBody = document.querySelector('tbody');
    const rows = tableBody!.querySelectorAll('tr[role="button"]');
    expect(rows.length).toBe(3);
    rows.forEach((row) => {
      expect(row).toHaveAttribute('tabindex', '0');
    });
  });

  // Custom render
  it('uses custom render function for cells', () => {
    const customColumns: Column<TestRow>[] = [
      {
        key: 'name',
        header: 'Name',
        render: (row) => <strong data-testid="bold-name">{row.name.toUpperCase()}</strong>,
      },
    ];

    render(<DataTable data={data} columns={customColumns} />);
    expect(screen.getByText('ALICE')).toBeInTheDocument();
  });

  // Null value handling
  it('shows dash for null/undefined cell values', () => {
    const sparseData = [{ id: 1, name: 'Test', age: 20, email: undefined as unknown as string }];
    render(<DataTable data={sparseData} columns={columns} />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  // Filters slot
  it('renders filters when provided', () => {
    render(
      <DataTable
        data={data}
        columns={columns}
        filters={<button>Filter Active</button>}
      />
    );
    expect(screen.getByText('Filter Active')).toBeInTheDocument();
  });
});
