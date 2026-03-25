export interface Category {
  id: number;
  user_id: number | null;
  name: string;
  parent_id: number | null;
  color: string;
  icon: string;
  children?: Category[];
}

export const findCategoryById = (id: number, categories: Category[]): Category | null => {
  for (const category of categories) {
    if (category.id === id) {
      return category;
    }
    if (category.children) {
      const found = findCategoryById(id, category.children);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export const findAncestors = (id: number, categories: Category[]): Category[] | null => {
  for (const category of categories) {
    if (category.id === id) return [];
    if (category.children?.length) {
      const path = findAncestors(id, category.children);
      if (path !== null) return [category, ...path];
    }
  }
  return null;
};

export const flattenCategories = (categories: Category[]): Category[] => {
  const result: Category[] = [];
  const visit = (nodes: Category[]) => {
    for (const node of nodes) {
      result.push(node);
      if (node.children?.length) visit(node.children);
    }
  };
  visit(categories);
  return result;
};