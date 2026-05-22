import { commands, window, workspace, Uri } from 'vscode';
import * as os from 'os';
import * as path from 'path';
import globalState from './globalState';
import { LeekFundConfig } from './shared/leekConfig';
import { cacheStockPriceData } from './shared/stockPriceCache';

/** 与「设置股票成本价」中保存的单条结构一致 */
export type StockPriceEntry = {
  name: string;
  amount: number;
  price: number | string;
  unitPrice: number;
  todayUnitPrice: number;
  isSellOut: boolean;
  earnings: number;
  priceDate: string;
  /** 回落告警阈值（%），0 关闭 */
  pullbackAlertPercent?: number;
};

function defaultStockPriceEntry(partial: Partial<StockPriceEntry> & { code: string }): StockPriceEntry {
  const entry: StockPriceEntry = {
    name: partial.name ?? '',
    amount: Number(partial.amount) || 0,
    price: partial.price ?? '',
    unitPrice: Number(partial.unitPrice) || 0,
    todayUnitPrice: Number(partial.todayUnitPrice) || 0,
    isSellOut: Boolean(partial.isSellOut),
    earnings: Number(partial.earnings) || 0,
    priceDate: partial.priceDate ?? '',
  };
  if (partial.pullbackAlertPercent !== undefined && partial.pullbackAlertPercent !== null) {
    entry.pullbackAlertPercent = Math.max(0, Number(partial.pullbackAlertPercent) || 0);
  }
  return entry;
}

/** 东方财富等导出：600000.SH、SZ000001、SH600000 */
export function normalizeImportedStockCode(raw: string): string | null {
  let s = raw.replace(/\ufeff/g, '').trim();
  if (!s) {
    return null;
  }
  const upper = s.toUpperCase();
  const dotM = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(upper);
  if (dotM) {
    const mkt = dotM[2].toLowerCase();
    return `${mkt}${dotM[1]}`;
  }
  if (/^(SH|SZ|BJ)\d{6}$/i.test(upper)) {
    return upper.toLowerCase();
  }
  if (/^HK\d+/i.test(upper)) {
    return `hk${upper.slice(2)}`.toLowerCase();
  }
  if (/^\d{5}$/.test(upper)) {
    return `hk${upper}`.toLowerCase();
  }
  if (/^\d{6}$/.test(upper)) {
    if (/^(60|68|69)/.test(upper)) {
      return `sh${upper}`;
    }
    if (/^(00|30)/.test(upper)) {
      return `sz${upper}`;
    }
    if (/^(43|83|87|88)/.test(upper)) {
      return `bj${upper}`;
    }
    return `sh${upper}`;
  }
  if (/^USR_/i.test(upper)) {
    return `usr_${upper.slice(4).toLowerCase()}`;
  }
  if (/^GB_/i.test(upper)) {
    return `gb_${upper.slice(3).toLowerCase()}`;
  }
  if (/^(SH|SZ|BJ|HK)/i.test(s)) {
    return s.toLowerCase();
  }
  return s.toLowerCase();
}

function parseBool(v: unknown): boolean {
  if (typeof v === 'boolean') {
    return v;
  }
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === '是';
}

function parseNumber(v: unknown): number {
  if (v === null || v === undefined || v === '') {
    return 0;
  }
  if (typeof v === 'number' && !Number.isNaN(v)) {
    return v;
  }
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === delimiter) {
      result.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  result.push(cur.trim());
  return result;
}

function detectDelimiter(headerLine: string): string {
  const tabs = (headerLine.match(/\t/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

const HEADER_ALIASES: Record<string, keyof ParsedRow> = {
  code: 'code',
  股票代码: 'code',
  证券代码: 'code',
  代码: 'code',
  amount: 'amount',
  持仓金额: 'amount',
  市值: 'amount',
  unitprice: 'unitPrice',
  成本价: 'unitPrice',
  成本: 'unitPrice',
  name: 'name',
  名称: 'name',
  证券名称: 'name',
  todayunitprice: 'todayUnitPrice',
  今日成本价: 'todayUnitPrice',
  issellout: 'isSellOut',
  清仓: 'isSellOut',
  shares: 'shares',
  持仓数量: 'shares',
  股数: 'shares',
  数量: 'shares',
  pullbackalertpercent: 'pullbackAlertPercent',
  回落告警: 'pullbackAlertPercent',
  回落: 'pullbackAlertPercent',
};

type ParsedRow = {
  code: string;
  amount?: number;
  unitPrice?: number;
  name?: string;
  todayUnitPrice?: number;
  isSellOut?: boolean;
  shares?: number;
  pullbackAlertPercent?: number;
};

function mapHeaderCell(h: string): string {
  return h.replace(/\ufeff/g, '').trim().toLowerCase();
}

function parseCSV(text: string): { rows: ParsedRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    errors.push('CSV 至少需要表头行与一行数据');
    return { rows: [], errors };
  }
  const delimiter = detectDelimiter(lines[0]);
  const headerCells = parseCSVLine(lines[0], delimiter).map(mapHeaderCell);
  const colIndex: Partial<Record<keyof ParsedRow, number>> = {};
  headerCells.forEach((cell, i) => {
    const key = HEADER_ALIASES[cell];
    if (key) {
      colIndex[key] = i;
    }
  });
  if (colIndex.code === undefined) {
    errors.push('CSV 表头需包含「股票代码」列（或 code）');
    return { rows: [], errors };
  }
  const rows: ParsedRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = parseCSVLine(lines[li], delimiter);
    const codeRaw = cells[colIndex.code!];
    const code = normalizeImportedStockCode(codeRaw);
    if (!code) {
      errors.push(`第 ${li + 1} 行：无效代码「${codeRaw}」`);
      continue;
    }
    const row: ParsedRow = { code };
    if (colIndex.name !== undefined) {
      row.name = cells[colIndex.name] ?? '';
    }
    if (colIndex.unitPrice !== undefined) {
      row.unitPrice = parseNumber(cells[colIndex.unitPrice]);
    }
    if (colIndex.amount !== undefined) {
      row.amount = parseNumber(cells[colIndex.amount]);
    }
    if (colIndex.todayUnitPrice !== undefined) {
      row.todayUnitPrice = parseNumber(cells[colIndex.todayUnitPrice]);
    }
    if (colIndex.shares !== undefined) {
      row.shares = parseNumber(cells[colIndex.shares]);
    }
    if (colIndex.isSellOut !== undefined) {
      row.isSellOut = parseBool(cells[colIndex.isSellOut]);
    }
    if (colIndex.pullbackAlertPercent !== undefined) {
      row.pullbackAlertPercent = parseNumber(cells[colIndex.pullbackAlertPercent]);
    }
    rows.push(row);
  }
  return { rows, errors };
}

function rowToEntry(row: ParsedRow, lineHint: string): { entry?: StockPriceEntry; error?: string } {
  let amount = row.amount ?? 0;
  const unitPrice = row.unitPrice ?? 0;
  const sellOut = Boolean(row.isSellOut);
  if ((!amount || amount <= 0) && row.shares && unitPrice > 0) {
    amount = row.shares * unitPrice;
  }
  if (!row.code) {
    return { error: `${lineHint}：缺少代码` };
  }
  if (!sellOut) {
    if (unitPrice <= 0) {
      return { error: `${lineHint}：${row.code} 成本价无效` };
    }
    if (amount <= 0) {
      return {
        error: `${lineHint}：${row.code} 持仓金额无效（可填持仓金额，或填持仓数量+成本价）`,
      };
    }
  }
  return {
    entry: defaultStockPriceEntry({
      name: row.name,
      amount: sellOut ? 0 : amount,
      unitPrice: sellOut ? 0 : unitPrice,
      todayUnitPrice: row.todayUnitPrice,
      isSellOut: sellOut,
      code: row.code,
      pullbackAlertPercent: row.pullbackAlertPercent,
    }),
  };
}

function pickPullback(o: Record<string, unknown>): number | undefined {
  const raw = o.pullbackAlertPercent ?? o['回落告警'] ?? o['回落'];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return undefined;
  }
  return Math.max(0, parseNumber(raw));
}

function parseJSON(text: string): { rows: ParsedRow[]; errors: string[] } {
  const errors: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    errors.push('JSON 解析失败');
    return { rows: [], errors };
  }
  const rows: ParsedRow[] = [];
  if (Array.isArray(data)) {
    data.forEach((item, i) => {
      if (!item || typeof item !== 'object') {
        errors.push(`数组第 ${i + 1} 项格式错误`);
        return;
      }
      const o = item as Record<string, unknown>;
      const codeRaw = String(o.code ?? o['股票代码'] ?? '').trim();
      const code = normalizeImportedStockCode(codeRaw);
      if (!code) {
        errors.push(`数组第 ${i + 1} 项：无效代码`);
        return;
      }
      const nameRaw = o.name ?? o['名称'];
      const name =
        nameRaw !== undefined && nameRaw !== null ? String(nameRaw) : undefined;
      const amountRaw = o.amount ?? o['持仓金额'];
      const unitRaw = o.unitPrice ?? o['成本价'] ?? o.cost;
      const pb = pickPullback(o);
      rows.push({
        code,
        name,
        amount:
          amountRaw !== undefined && amountRaw !== null ? parseNumber(amountRaw) : undefined,
        unitPrice: unitRaw !== undefined && unitRaw !== null ? parseNumber(unitRaw) : undefined,
        todayUnitPrice: parseNumber(o.todayUnitPrice ?? o['今日成本价']),
        isSellOut: parseBool(o.isSellOut ?? o['清仓'] ?? false),
        shares: parseNumber(o.shares ?? o['持仓数量'] ?? o['股数']),
        ...(pb !== undefined ? { pullbackAlertPercent: pb } : {}),
      });
    });
    return { rows, errors };
  }
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const code = normalizeImportedStockCode(k);
      if (!code || !v || typeof v !== 'object') {
        continue;
      }
      const o = v as Record<string, unknown>;
      const nameRaw = o.name;
      const pb = pickPullback(o);
      rows.push({
        code,
        name:
          nameRaw !== undefined && nameRaw !== null ? String(nameRaw) : undefined,
        amount: parseNumber(o.amount),
        unitPrice: parseNumber(o.unitPrice ?? o.cost),
        todayUnitPrice: parseNumber(o.todayUnitPrice),
        isSellOut: parseBool(o.isSellOut ?? false),
        shares: parseNumber(o.shares),
        ...(pb !== undefined ? { pullbackAlertPercent: pb } : {}),
      });
    }
    if (rows.length === 0) {
      errors.push('JSON 对象中无有效持仓条目');
    }
    return { rows, errors };
  }
  errors.push('JSON 须为对象（代码→字段）或数组');
  return { rows: [], errors };
}

function sniffFormat(text: string, ext: string): 'json' | 'csv' {
  const lowerExt = ext.toLowerCase();
  if (lowerExt === '.csv' || lowerExt === '.tsv') {
    return 'csv';
  }
  if (lowerExt === '.json') {
    return 'json';
  }
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    return 'json';
  }
  return 'csv';
}

export function parseHoldingsFileContent(text: string, ext: string): {
  cfg: Record<string, StockPriceEntry>;
  errors: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  let rows: ParsedRow[] = [];
  const fmt = sniffFormat(text, ext);
  if (fmt === 'csv') {
    const r = parseCSV(text);
    rows = r.rows;
    errors.push(...r.errors);
  } else {
    const r = parseJSON(text);
    rows = r.rows;
    errors.push(...r.errors);
  }
  const cfg: Record<string, StockPriceEntry> = {};
  rows.forEach((row, i) => {
    const hint = `第 ${i + 1} 条`;
    const { entry, error } = rowToEntry(row, hint);
    if (error) {
      warnings.push(error);
      return;
    }
    if (entry) {
      cfg[row.code] = entry;
    }
  });
  return { cfg, errors, warnings };
}

function defaultImportPath(): string {
  const wf = workspace.workspaceFolders;
  if (wf && wf.length > 0) {
    return path.join(wf[0].uri.fsPath, 'stock-holdings-import.json');
  }
  return path.join(os.homedir(), 'Downloads', 'stock-holdings-import.json');
}

export async function runImportStockHoldings(stockProvider: { refresh: () => void }) {
  const uris = await window.showOpenDialog({
    defaultUri: Uri.file(defaultImportPath()),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      '持仓表 (JSON / CSV)': ['json', 'csv', 'tsv', 'txt'],
      'All files': ['*'],
    },
  });
  if (!uris?.length) {
    return;
  }
  const uri = uris[0];
  const buf = await workspace.fs.readFile(uri);
  const text = Buffer.from(buf).toString('utf8');
  const ext = path.extname(uri.fsPath) || '.json';
  const { cfg, errors, warnings } = parseHoldingsFileContent(text, ext);
  if (errors.length) {
    window.showErrorMessage(errors.slice(0, 3).join('；') + (errors.length > 3 ? '…' : ''));
    return;
  }
  if (Object.keys(cfg).length === 0) {
    window.showWarningMessage('没有可导入的有效持仓行');
    if (warnings.length) {
      window.showInformationMessage(warnings.slice(0, 8).join('\n'));
    }
    return;
  }
  const mode = await window.showQuickPick(
    [
      {
        label: '合并到现有持仓',
        description: '同名代码覆盖；其余配置保留',
        mode: 'merge' as const,
      },
      {
        label: '仅保留本次导入的持仓',
        description: '清空其它股票持仓金额配置（自选股列表不变）',
        mode: 'replace' as const,
      },
    ],
    { placeHolder: '选择导入方式' }
  );
  if (!mode) {
    return;
  }
  const prev = (globalState.stockPrice || {}) as Record<string, StockPriceEntry>;
  let next: Record<string, StockPriceEntry>;
  if (mode.mode === 'merge') {
    next = { ...prev };
    for (const code of Object.keys(cfg)) {
      next[code] = { ...(prev[code] || {}), ...cfg[code] } as StockPriceEntry;
    }
  } else {
    next = { ...cfg };
  }
  await LeekFundConfig.setConfig('panxun.stockPrice', next);
  cacheStockPriceData(next);
  const codes = Object.keys(cfg);
  LeekFundConfig.updateStockCfg(codes.join(','), () => {
    stockProvider.refresh();
  });
  commands.executeCommand('panxun.refreshStock');
  let msg = `已导入 ${codes.length} 只股票持仓`;
  if (warnings.length) {
    msg += `，跳过 ${warnings.length} 行`;
    window.showInformationMessage(msg);
    window.showWarningMessage(warnings.slice(0, 10).join('；') + (warnings.length > 10 ? '…' : ''));
  } else {
    window.showInformationMessage(msg);
  }
}
