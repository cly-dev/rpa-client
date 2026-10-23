import { useEffect, useState, type ReactNode } from 'react';

interface PaginationProps {
  readonly page: number;
  readonly totalPages: number;
  readonly disabled?: boolean;
  readonly onPageChange: (page: number) => void;
}

export function normalizePageInput(value: string, totalPages: number, currentPage: number): number {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return currentPage;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return currentPage;
  return Math.min(Math.max(parsed, 1), Math.max(1, totalPages));
}

export function Pagination({ page, totalPages, disabled = false, onPageChange }: PaginationProps): ReactNode {
  const [draft, setDraft] = useState(String(page));

  useEffect(() => { setDraft(String(page)); }, [page]);

  const goToDraftPage = (): void => {
    const target = normalizePageInput(draft, totalPages, page);
    setDraft(String(target));
    if (target !== page) onPageChange(target);
  };

  return <div className="workbench-pagination">
    <button type="button" disabled={page <= 1 || disabled} onClick={() => onPageChange(page - 1)}>上一页</button>
    <label className="workbench-pagination-page">
      <span>第</span>
      <input
        type="number"
        min={1}
        max={Math.max(1, totalPages)}
        step={1}
        inputMode="numeric"
        aria-label="输入页码"
        value={draft}
        disabled={disabled}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') goToDraftPage();
          if (event.key === 'Escape') setDraft(String(page));
        }}
      />
      <span>/ {totalPages} 页</span>
    </label>
    <button type="button" disabled={disabled || draft.trim() === ''} onClick={goToDraftPage}>跳转</button>
    <button type="button" disabled={page >= totalPages || disabled} onClick={() => onPageChange(page + 1)}>下一页</button>
  </div>;
}
