export interface PageParams {
  page: number;
  limit: number;
  skip: number;
}

export const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 20;

const toPositiveInt = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = parseInt(value, 10);
  return parsed > 0 ? parsed : null;
};

/**
 * Opt-in pagination: returns null when neither `page` nor `limit` is present so
 * existing callers (customer app, store pickers) keep receiving a plain array.
 * Invalid values fall back to page 1 / default limit; limit is capped.
 */
export const parsePagination = (query: Record<string, unknown>): PageParams | null => {
  if (query.page === undefined && query.limit === undefined) return null;
  const page = toPositiveInt(query.page) ?? 1;
  const limit = Math.min(toPositiveInt(query.limit) ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
};

export const paginationMeta = (total: number, { page, limit }: PageParams) => ({
  total,
  page,
  limit,
  totalPages: Math.ceil(total / limit),
});
