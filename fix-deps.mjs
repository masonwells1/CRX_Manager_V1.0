/**
 * Automated fix for react-hooks/exhaustive-deps ESLint warnings.
 *
 * Strategy for each file:
 * 1. Ensure useCallback is in the React import
 * 2. Wrap specified functions with useCallback(fn, [deps])
 * 3. Add those functions to the useEffect dep arrays
 * 4. For useMemo: move constants outside the component
 */
import fs from 'fs';
import path from 'path';

const PAGES = 'src/pages';

function read(file) {
  return fs.readFileSync(path.join(PAGES, file), 'utf8');
}
function write(file, content) {
  fs.writeFileSync(path.join(PAGES, file), content, 'utf8');
}

/** Ensure useCallback is in the React import */
function ensureUseCallback(c) {
  if (/import\s*\{[^}]*\buseCallback\b[^}]*\}\s*from\s*['"]react['"]/.test(c)) return c;
  return c.replace(
    /(import\s*\{)([^}]*)(}\s*from\s*['"]react['"])/,
    (_, open, imports, close) => {
      return `${open}${imports}, useCallback ${close}`;
    }
  );
}

/**
 * Wrap a top-level `const funcName = async (...) => {` with useCallback.
 * Finds the function, counts braces to find its end `};`, and replaces with `}, [deps]);`
 */
function wrapFuncWithUseCallback(content, funcName, deps) {
  // Check if already wrapped
  if (content.includes(`const ${funcName} = useCallback(`)) return content;

  // Pattern: `  const funcName = async (` or `  const funcName = async(`
  const funcStart = content.indexOf(`const ${funcName} = async (`);
  const funcStart2 = content.indexOf(`const ${funcName} = async(`);
  const idx = funcStart !== -1 ? funcStart : funcStart2;

  if (idx === -1) {
    console.warn(`  WARN: Could not find "const ${funcName} = async" in content`);
    return content;
  }

  // Insert useCallback( after the =
  const eqIdx = content.indexOf('=', idx + `const ${funcName}`.length);
  content = content.substring(0, eqIdx + 2) + 'useCallback(' + content.substring(eqIdx + 2);

  // Now find the body's opening brace
  const searchFrom = eqIdx + 2 + 'useCallback('.length;
  const bodyStart = content.indexOf('{', searchFrom);
  if (bodyStart === -1) {
    console.warn(`  WARN: Could not find opening brace for ${funcName}`);
    return content;
  }

  // Count braces to find end
  let braceCount = 1;
  let i = bodyStart + 1;
  while (i < content.length && braceCount > 0) {
    if (content[i] === '{') braceCount++;
    else if (content[i] === '}') braceCount--;
    i++;
  }
  // i points to right after the closing }

  // Now check what follows - should be `;` (the original `};`)
  const after = content.substring(i).trimStart();
  if (after.startsWith(';')) {
    const semiIdx = content.indexOf(';', i);
    const depsStr = deps.length > 0 ? deps.join(', ') : '';
    content = content.substring(0, semiIdx) + `, [${depsStr}])` + content.substring(semiIdx);
  } else {
    console.warn(`  WARN: Expected ; after closing brace for ${funcName}, found: "${content.substring(i, i+10)}"`);
  }

  return content;
}

/**
 * Replace a useEffect's dep array.
 * Finds the specific useEffect by matching the body content pattern, then replaces deps.
 */
function replaceEffectDeps(content, bodySnippet, oldDeps, newDeps) {
  // Find the effect containing this body snippet
  const snippetIdx = content.indexOf(bodySnippet);
  if (snippetIdx === -1) {
    console.warn(`  WARN: Could not find useEffect snippet: "${bodySnippet.substring(0, 50)}..."`);
    return content;
  }

  // Find the dep array that follows the closing of this useEffect callback
  // Search forward from the snippet for `}, [` pattern
  // But we need to find the specific `], [deps]);` pattern near this effect

  // Find oldDeps pattern near the snippet
  const searchRegion = content.substring(Math.max(0, snippetIdx - 200), snippetIdx + bodySnippet.length + 200);
  const regionStart = Math.max(0, snippetIdx - 200);

  // Find the exact old deps string
  const oldDepsStr = `[${oldDeps}]`;
  const newDepsStr = `[${newDeps}]`;

  // Search near the snippet location
  const searchStart = snippetIdx;
  const searchEnd = Math.min(content.length, snippetIdx + bodySnippet.length + 200);
  const region = content.substring(searchStart, searchEnd);

  const depIdx = region.indexOf(`}, ${oldDepsStr}`);
  if (depIdx !== -1) {
    const absoluteIdx = searchStart + depIdx;
    content = content.substring(0, absoluteIdx) + `}, ${newDepsStr}` + content.substring(absoluteIdx + `}, ${oldDepsStr}`.length);
    return content;
  }

  // Try with extra whitespace
  const depIdx2 = region.indexOf(`}, ${oldDepsStr}`);
  if (depIdx2 === -1) {
    console.warn(`  WARN: Could not find dep array [${oldDeps}] near snippet`);
  }

  return content;
}

// =====================================================================
// File-by-file fixes
// =====================================================================

function fixFile(filename, fixFn) {
  console.log(`Fixing ${filename}...`);
  let c = read(filename);
  c = fixFn(c);
  write(filename, c);
}

// ─── ARaging.tsx ───
fixFile('ARaging.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchAging', ['asOfDate', 'toast']);
  c = wrapFuncWithUseCallback(c, 'fetchSeasonComparison', ['seasonA', 'seasonB', 'toast']);
  c = replaceEffectDeps(c, "if (tab === 'aging') fetchAging()", '', 'tab, asOfDate, seasonA, seasonB, fetchAging, fetchSeasonComparison');
  // The old deps were [tab, asOfDate, seasonA, seasonB] - need to replace exactly
  // Actually let's just do a direct string replace for the dep array
  c = c.replace(
    "}, [tab, asOfDate, seasonA, seasonB]);",
    "}, [tab, asOfDate, seasonA, seasonB, fetchAging, fetchSeasonComparison]);"
  );
  return c;
});

// ─── ApplicationRecords.tsx ───
fixFile('ApplicationRecords.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchRecords', ['startDate', 'endDate', 'customerFilter', 'toast']);
  c = c.replace(
    "}, [startDate, endDate, customerFilter]);",
    "}, [startDate, endDate, customerFilter, fetchRecords]);"
  );
  return c;
});

// ─── BlendRecipes.tsx ───
fixFile('BlendRecipes.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchRecipes', ['toast']);
  c = wrapFuncWithUseCallback(c, 'fetchProducts', []);
  c = c.replace(
    "  useEffect(() => {\n    fetchRecipes();\n    fetchProducts();\n  }, []);",
    "  useEffect(() => {\n    fetchRecipes();\n    fetchProducts();\n  }, [fetchRecipes, fetchProducts]);"
  );
  return c;
});

// ─── BlendTicketDetail.tsx ───
fixFile('BlendTicketDetail.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'loadTicketData', ['id', 'toast', 'navigate']);
  c = c.replace(
    "  useEffect(() => {\n    if (id) {\n      loadTicketData();\n    }\n  }, [id]);",
    "  useEffect(() => {\n    if (id) {\n      loadTicketData();\n    }\n  }, [id, loadTicketData]);"
  );
  return c;
});

// ─── CommissionPayments.tsx ───
fixFile('CommissionPayments.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchPayments', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchPayments();\n  }, []);",
    "  useEffect(() => {\n    fetchPayments();\n  }, [fetchPayments]);"
  );
  return c;
});

// ─── Compliance.tsx (fetchData depends on tab state) ───
fixFile('Compliance.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchData', ['tab', 'toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchData();\n  }, [tab]);",
    "  useEffect(() => {\n    fetchData();\n  }, [tab, fetchData]);"
  );
  return c;
});

// ─── CropPrograms.tsx ───
fixFile('CropPrograms.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchPrograms', ['toast']);
  c = c.replace(
    /  useEffect\(\(\) => \{\n    fetchPrograms\(\);\n  \}, \[\]\);/,
    "  useEffect(() => {\n    fetchPrograms();\n  }, [fetchPrograms]);"
  );
  return c;
});

// ─── CustomerDetail.tsx ───
fixFile('CustomerDetail.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchCustomer', ['id', 'toast']);
  c = wrapFuncWithUseCallback(c, 'fetchAddresses', ['id']);
  c = wrapFuncWithUseCallback(c, 'fetchTabData', ['id', 'toast']);
  // Main effect: references fetchCustomer, fetchAddresses, isNew
  c = c.replace(
    "    if (!isNew && id) {\n      fetchCustomer();\n      fetchAddresses();\n    } else {\n      // New customer — mark ready immediately\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id]);",
    "    if (!isNew && id) {\n      fetchCustomer();\n      fetchAddresses();\n    } else {\n      // New customer — mark ready immediately\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id, isNew, fetchCustomer, fetchAddresses]);"
  );
  // Tab effect
  c = c.replace(
    "  useEffect(() => {\n    if (!isNew && id && tab !== 'info') {\n      fetchTabData(tab);\n    }\n  }, [tab, id]);",
    "  useEffect(() => {\n    if (!isNew && id && tab !== 'info') {\n      fetchTabData(tab);\n    }\n  }, [tab, id, isNew, fetchTabData]);"
  );
  return c;
});

// ─── Customers.tsx ───
fixFile('Customers.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchCustomers', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchCustomers();\n  }, []);",
    "  useEffect(() => {\n    fetchCustomers();\n  }, [fetchCustomers]);"
  );
  return c;
});

// ─── Dashboard.tsx ───
fixFile('Dashboard.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchDashboard', ['role', 'toast']);
  // Actually fetchDashboard references `role` through `profile` closure... let me check
  // Looking at the code, the effect already has [role] as dep and fetchDashboard is called within.
  // fetchDashboard itself uses supabase RPCs and `role` for notification checks.
  c = c.replace(
    "  useEffect(() => {\n    fetchDashboard();\n  }, [role]);",
    "  useEffect(() => {\n    fetchDashboard();\n  }, [role, fetchDashboard]);"
  );
  return c;
});

// ─── Deliveries.tsx ───
fixFile('Deliveries.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchDeliveries', ['toast']);
  c = wrapFuncWithUseCallback(c, 'fetchDrivers', []);
  c = wrapFuncWithUseCallback(c, 'fetchCustomers', []);
  c = wrapFuncWithUseCallback(c, 'fetchRemainderCount', []);
  c = c.replace(
    "  useEffect(() => {\n    fetchDeliveries();\n    fetchDrivers();\n    fetchCustomers();\n    fetchRemainderCount();\n  }, []);",
    "  useEffect(() => {\n    fetchDeliveries();\n    fetchDrivers();\n    fetchCustomers();\n    fetchRemainderCount();\n  }, [fetchDeliveries, fetchDrivers, fetchCustomers, fetchRemainderCount]);"
  );
  return c;
});

// ─── FieldDetail.tsx ───
fixFile('FieldDetail.tsx', (c) => {
  // Already has useCallback imported
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchCustomers', []);
  c = wrapFuncWithUseCallback(c, 'fetchField', ['id', 'toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchCustomers();\n    if (!isNew && id) {\n      fetchField();\n    } else {\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id]);",
    "  useEffect(() => {\n    fetchCustomers();\n    if (!isNew && id) {\n      fetchField();\n    } else {\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id, isNew, fetchCustomers, fetchField]);"
  );
  return c;
});

// ─── Fields.tsx ───
fixFile('Fields.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchFields', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchFields();\n  }, []);",
    "  useEffect(() => {\n    fetchFields();\n  }, [fetchFields]);"
  );
  return c;
});

// ─── InventoryPage.tsx ───
fixFile('InventoryPage.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchInventory', ['toast']);
  c = wrapFuncWithUseCallback(c, 'fetchHolds', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchInventory();\n    fetchHolds();\n  }, []);",
    "  useEffect(() => {\n    fetchInventory();\n    fetchHolds();\n  }, [fetchInventory, fetchHolds]);"
  );
  return c;
});

// ─── InvoiceDetail.tsx ───
fixFile('InvoiceDetail.tsx', (c) => {
  // Already has useCallback imported
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchInvoice', ['toast', 'navigate']);
  c = c.replace(
    "  useEffect(() => {\n    if (!isNew && id) fetchInvoice(id);\n  }, [id, isNew]);",
    "  useEffect(() => {\n    if (!isNew && id) fetchInvoice(id);\n  }, [id, isNew, fetchInvoice]);"
  );
  return c;
});

// ─── Invoices.tsx ───
fixFile('Invoices.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchInvoices', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchInvoices();\n  }, []);",
    "  useEffect(() => {\n    fetchInvoices();\n  }, [fetchInvoices]);"
  );
  return c;
});

// ─── JobDetail.tsx ───
fixFile('JobDetail.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchJob', ['id', 'toast', 'navigate']);
  // loadLookups is not flagged, only fetchJob and isNew in the deps
  c = c.replace(
    "    if (!isNew && id) {\n      fetchJob();\n    } else {\n      // Check for recipe_id from search params\n      const recipeParam = searchParams.get('recipe_id');\n      if (recipeParam) setRecipeId(recipeParam);\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id]);",
    "    if (!isNew && id) {\n      fetchJob();\n    } else {\n      // Check for recipe_id from search params\n      const recipeParam = searchParams.get('recipe_id');\n      if (recipeParam) setRecipeId(recipeParam);\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id, isNew, fetchJob, searchParams]);"
  );
  return c;
});

// ─── NewDelivery.tsx ───
fixFile('NewDelivery.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchOrders', []);
  c = wrapFuncWithUseCallback(c, 'fetchDrivers', []);
  c = wrapFuncWithUseCallback(c, 'fetchOrderDetails', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchOrders();\n    fetchDrivers();\n    setTimeout(() => { initialLoadDone.current = true; }, 0);\n  }, []);",
    "  useEffect(() => {\n    fetchOrders();\n    fetchDrivers();\n    setTimeout(() => { initialLoadDone.current = true; }, 0);\n  }, [fetchOrders, fetchDrivers]);"
  );
  c = c.replace(
    "  useEffect(() => {\n    if (selectedOrderId) {\n      fetchOrderDetails(selectedOrderId);\n    } else {\n      setOrderItems([]);\n      setCustomer(null);\n      setAddresses([]);\n      setDeliveryItems([]);\n    }\n  }, [selectedOrderId]);",
    "  useEffect(() => {\n    if (selectedOrderId) {\n      fetchOrderDetails(selectedOrderId);\n    } else {\n      setOrderItems([]);\n      setCustomer(null);\n      setAddresses([]);\n      setDeliveryItems([]);\n    }\n  }, [selectedOrderId, fetchOrderDetails]);"
  );
  return c;
});

// ─── NewOrder.tsx ───
fixFile('NewOrder.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchData', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchData();\n  }, []);",
    "  useEffect(() => {\n    fetchData();\n  }, [fetchData]);"
  );
  return c;
});

// ─── NewPurchaseOrder.tsx ───
fixFile('NewPurchaseOrder.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchProducts', []);
  c = c.replace(
    "  useEffect(() => {\n    fetchProducts();\n    setTimeout(() => { initialLoadDone.current = true; }, 0);\n  }, []);",
    "  useEffect(() => {\n    fetchProducts();\n    setTimeout(() => { initialLoadDone.current = true; }, 0);\n  }, [fetchProducts]);"
  );
  return c;
});

// ─── OrderDetail.tsx ───
fixFile('OrderDetail.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchOrder', ['id', 'toast']);
  c = c.replace(
    "  useEffect(() => {\n    if (id) fetchOrder();\n  }, [id]);",
    "  useEffect(() => {\n    if (id) fetchOrder();\n  }, [id, fetchOrder]);"
  );
  return c;
});

// ─── Orders.tsx ───
fixFile('Orders.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchOrders', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchOrders();\n  }, []);",
    "  useEffect(() => {\n    fetchOrders();\n  }, [fetchOrders]);"
  );
  return c;
});

// ─── PrepaymentManager.tsx ───
fixFile('PrepaymentManager.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchCustomers', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchCustomers();\n  }, []);",
    "  useEffect(() => {\n    fetchCustomers();\n  }, [fetchCustomers]);"
  );
  return c;
});

// ─── ProductDetail.tsx ───
fixFile('ProductDetail.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchProduct', ['id']);
  c = wrapFuncWithUseCallback(c, 'fetchCostHistory', ['id']);
  c = c.replace(
    "  useEffect(() => {\n    if (!isNew && id) {\n      fetchProduct();\n      fetchCostHistory();\n    } else {\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id]);",
    "  useEffect(() => {\n    if (!isNew && id) {\n      fetchProduct();\n      fetchCostHistory();\n    } else {\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id, isNew, fetchProduct, fetchCostHistory]);"
  );
  return c;
});

// ─── Products.tsx ───
fixFile('Products.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchProducts', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchProducts();\n  }, []);",
    "  useEffect(() => {\n    fetchProducts();\n  }, [fetchProducts]);"
  );
  return c;
});

// ─── PurchaseOrderDetail.tsx ───
fixFile('PurchaseOrderDetail.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchPO', ['id']);
  c = wrapFuncWithUseCallback(c, 'fetchReceivingHistory', ['id']);
  c = c.replace(
    "  useEffect(() => {\n    if (id) {\n      fetchPO();\n      fetchReceivingHistory();\n    }\n  }, [id]);",
    "  useEffect(() => {\n    if (id) {\n      fetchPO();\n      fetchReceivingHistory();\n    }\n  }, [id, fetchPO, fetchReceivingHistory]);"
  );
  return c;
});

// ─── PurchaseOrders.tsx (also needs CANCELLABLE moved outside) ───
fixFile('PurchaseOrders.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchPOs', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchPOs();\n  }, []);",
    "  useEffect(() => {\n    fetchPOs();\n  }, [fetchPOs]);"
  );
  // Move CANCELLABLE outside the component
  c = c.replace(
    "  const CANCELLABLE = ['draft', 'submitted'];",
    "  // CANCELLABLE moved outside component body"
  );
  // Insert before the component function
  c = c.replace(
    "export default function PurchaseOrders() {",
    "const CANCELLABLE = ['draft', 'submitted'];\n\nexport default function PurchaseOrders() {"
  );
  // Fix the comment inside
  c = c.replace(
    "  // CANCELLABLE moved outside component body\n",
    ""
  );
  return c;
});

// ─── QuoteBuilder.tsx ───
fixFile('QuoteBuilder.tsx', (c) => {
  // Already has useCallback imported
  c = wrapFuncWithUseCallback(c, 'fetchReferenceData', ['toast']);
  c = wrapFuncWithUseCallback(c, 'fetchQuote', ['toast', 'navigate']);

  // Remove unused eslint-disable directive (line 156)
  c = c.replace(
    "  // Mark dirty whenever user changes form data (after initial load)\n  useEffect(() => {\n    if (!initialLoadDone.current) return;\n    setIsDirty(true);\n  // eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [customerId, tier, validDays, headerNotes, footerNotes, sections, commissionSplit]);",
    "  // Mark dirty whenever user changes form data (after initial load)\n  useEffect(() => {\n    if (!initialLoadDone.current) return;\n    setIsDirty(true);\n  }, [customerId, tier, validDays, headerNotes, footerNotes, sections, commissionSplit]);"
  );

  c = c.replace(
    "  useEffect(() => {\n    fetchReferenceData();\n    if (isEditing && id) {\n      fetchQuote(id);\n    } else {\n      generateQuoteNumber().then(() => {\n        // Allow a tick for state to settle before tracking changes\n        setTimeout(() => { initialLoadDone.current = true; }, 0);\n      }).catch(() => { /* non-critical: quote number defaults handled inside generateQuoteNumber */ });\n    }\n  }, [id]);",
    "  useEffect(() => {\n    fetchReferenceData();\n    if (isEditing && id) {\n      fetchQuote(id);\n    } else {\n      generateQuoteNumber().then(() => {\n        // Allow a tick for state to settle before tracking changes\n        setTimeout(() => { initialLoadDone.current = true; }, 0);\n      }).catch(() => { /* non-critical: quote number defaults handled inside generateQuoteNumber */ });\n    }\n  }, [id, isEditing, fetchReferenceData, fetchQuote]);"
  );
  return c;
});

// ─── Quotes.tsx (also needs DELETABLE moved outside) ───
fixFile('Quotes.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchQuotes', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchQuotes();\n  }, []);",
    "  useEffect(() => {\n    fetchQuotes();\n  }, [fetchQuotes]);"
  );
  // Move DELETABLE outside the component
  c = c.replace(
    "  const canBulkAction = profile?.role === 'admin' || profile?.role === 'sales_rep';\n  const DELETABLE = ['draft', 'sent', 'revised'];",
    "  const canBulkAction = profile?.role === 'admin' || profile?.role === 'sales_rep';"
  );
  c = c.replace(
    "export default function Quotes() {",
    "const DELETABLE = ['draft', 'sent', 'revised'];\n\nexport default function Quotes() {"
  );
  return c;
});

// ─── Rebates.tsx ───
fixFile('Rebates.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchPrograms', ['toast']);
  c = wrapFuncWithUseCallback(c, 'fetchClaims', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    if (tab === 'programs') fetchPrograms();\n    else fetchClaims();\n  }, [tab]);",
    "  useEffect(() => {\n    if (tab === 'programs') fetchPrograms();\n    else fetchClaims();\n  }, [tab, fetchPrograms, fetchClaims]);"
  );
  return c;
});

// ─── ReceivingLog.tsx ───
fixFile('ReceivingLog.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchData', ['vendorFilter', 'conditionFilter', 'receivedByFilter', 'dateFrom', 'dateTo', 'toast']);
  c = wrapFuncWithUseCallback(c, 'fetchStaff', []);
  c = c.replace(
    "  useEffect(() => {\n    fetchData();\n    fetchStaff();\n  }, []);",
    "  useEffect(() => {\n    fetchData();\n    fetchStaff();\n  }, [fetchData, fetchStaff]);"
  );
  c = c.replace(
    "  useEffect(() => {\n    fetchData();\n  }, [vendorFilter, conditionFilter, receivedByFilter, dateFrom, dateTo]);",
    "  useEffect(() => {\n    fetchData();\n  }, [vendorFilter, conditionFilter, receivedByFilter, dateFrom, dateTo, fetchData]);"
  );
  return c;
});

// ─── Reports.tsx ───
fixFile('Reports.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchProfitability', ['toast']);
  c = wrapFuncWithUseCallback(c, 'fetchFinancial', ['toast']);
  c = wrapFuncWithUseCallback(c, 'fetchOperational', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    if (category === 'profitability') fetchProfitability();\n    if (category === 'financial') fetchFinancial();\n    if (category === 'operational') fetchOperational();\n  }, [category, profitTab, financialTab, operationalTab, startDate, endDate, grossSalesGroupBy, chemProductId]);",
    "  useEffect(() => {\n    if (category === 'profitability') fetchProfitability();\n    if (category === 'financial') fetchFinancial();\n    if (category === 'operational') fetchOperational();\n  }, [category, profitTab, financialTab, operationalTab, startDate, endDate, grossSalesGroupBy, chemProductId, fetchProfitability, fetchFinancial, fetchOperational]);"
  );
  // Year-end effect: missing yeCustomerOptions.length
  c = c.replace(
    "  }, [category]);",
    "  }, [category, yeCustomerOptions.length]);"
  );
  return c;
});

// ─── Returns.tsx ───
fixFile('Returns.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchReturns', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchReturns();\n  }, []);",
    "  useEffect(() => {\n    fetchReturns();\n  }, [fetchReturns]);"
  );
  return c;
});

// ─── SettingsPage.tsx ───
fixFile('SettingsPage.tsx', (c) => {
  // Already has useCallback imported
  c = ensureUseCallback(c);
  // navigate is missing from the dep array at line 152
  c = c.replace(
    "  useEffect(() => {\n    if (role !== 'admin') {\n      navigate('/');\n      return;\n    }\n    fetchSettings();\n    fetchUsers();\n  }, [role]);",
    "  useEffect(() => {\n    if (role !== 'admin') {\n      navigate('/');\n      return;\n    }\n    fetchSettings();\n    fetchUsers();\n  }, [role, navigate]);"
  );
  return c;
});

// ─── TeamBoard.tsx ───
fixFile('TeamBoard.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchNotes', ['toast']);
  c = wrapFuncWithUseCallback(c, 'fetchProfiles', ['toast']);
  c = wrapFuncWithUseCallback(c, 'fetchGlobalActivity', ['activityDateFrom', 'activityDateTo', 'activityUser', 'activityAction', 'toast']);
  // openNoteDetail is async and uses notes state plus supabase
  c = wrapFuncWithUseCallback(c, 'openNoteDetail', ['notes', 'toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchNotes();\n    fetchProfiles();\n\n    const noteId = searchParams.get('note');\n    if (noteId) {\n      openNoteDetail(noteId);\n    }\n  }, [searchParams]);",
    "  useEffect(() => {\n    fetchNotes();\n    fetchProfiles();\n\n    const noteId = searchParams.get('note');\n    if (noteId) {\n      openNoteDetail(noteId);\n    }\n  }, [searchParams, fetchNotes, fetchProfiles, openNoteDetail]);"
  );
  c = c.replace(
    "  useEffect(() => {\n    if (viewTab === 'activity') {\n      fetchGlobalActivity();\n    }\n  }, [viewTab, activityDateFrom, activityDateTo, activityUser, activityAction]);",
    "  useEffect(() => {\n    if (viewTab === 'activity') {\n      fetchGlobalActivity();\n    }\n  }, [viewTab, activityDateFrom, activityDateTo, activityUser, activityAction, fetchGlobalActivity]);"
  );
  return c;
});

// ─── VehicleDetail.tsx ───
fixFile('VehicleDetail.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchVehicle', ['id', 'toast', 'navigate']);
  c = c.replace(
    "  useEffect(() => {\n    if (!isNew && id) {\n      fetchVehicle();\n    } else {\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id]);",
    "  useEffect(() => {\n    if (!isNew && id) {\n      fetchVehicle();\n    } else {\n      setTimeout(() => { initialLoadDone.current = true; }, 0);\n    }\n  }, [id, isNew, fetchVehicle]);"
  );
  return c;
});

// ─── Vehicles.tsx ───
fixFile('Vehicles.tsx', (c) => {
  c = ensureUseCallback(c);
  c = wrapFuncWithUseCallback(c, 'fetchVehicles', ['toast']);
  c = c.replace(
    "  useEffect(() => {\n    fetchVehicles();\n  }, []);",
    "  useEffect(() => {\n    fetchVehicles();\n  }, [fetchVehicles]);"
  );
  return c;
});

console.log('\nDone! All files processed.');
