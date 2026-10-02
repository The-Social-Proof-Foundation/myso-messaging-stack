/** Fallback categories when GraphQL `organizationCategories` is unavailable. */
export const ORGANIZATION_CATEGORIES = [
  {value: 0, slug: 'company', displayName: 'Company'},
  {value: 1, slug: 'startup', displayName: 'Startup'},
  {value: 2, slug: 'investment-fund', displayName: 'Investment fund'},
  {value: 3, slug: 'nonprofit', displayName: 'Nonprofit'},
  {value: 4, slug: 'research', displayName: 'Research'},
  {value: 5, slug: 'government', displayName: 'Government'},
  {value: 6, slug: 'media', displayName: 'Media'},
  {value: 7, slug: 'stewardship', displayName: 'Stewardship'},
  {value: 8, slug: 'brand', displayName: 'Brand'},
  {value: 9, slug: 'community', displayName: 'Community'},
  {value: 10, slug: 'sports', displayName: 'Sports'},
  {value: 11, slug: 'education', displayName: 'Education'},
  {value: 12, slug: 'healthcare', displayName: 'Healthcare'},
  {value: 13, slug: 'other', displayName: 'Other'},
] as const;

export type OrganizationCategory = {
  value: number;
  slug: string;
  displayName: string;
};

export function organizationCategoryLabel(value: number): string {
  return ORGANIZATION_CATEGORIES.find((c) => c.value === value)?.displayName ?? `Type ${value}`;
}
