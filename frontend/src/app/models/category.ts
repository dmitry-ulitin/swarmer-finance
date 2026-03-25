export interface Category {
  id: number;
  user_id: number | null;
  name: string;
  parent_id: number | null;
  color: string;
  icon: string;
  fullName: string;
  rootId: number;
  children?: Category[];
}

export const withComputedFields = (categories: Category[], ancestorPath = '', rootId = 0): Category[] =>
  categories.map(category => {
    const isRoot = category.parent_id === null;
    const currentRootId = isRoot ? category.id : rootId;
    const fullName = isRoot
      ? category.name
      : ancestorPath ? `${ancestorPath}/${category.name}` : category.name;
    const nextPath = isRoot ? '' : fullName;
    return {
      ...category,
      fullName,
      rootId: currentRootId,
      children: category.children
        ? withComputedFields(category.children, nextPath, currentRootId)
        : undefined,
    };
  });

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