const definitions = {
  collection: {
    title: '文件收纳',
    fields(input, readReference) {
      if (input.refs !== undefined && (!Array.isArray(input.refs) || input.refs.length > 100)) throw Error('收纳区数据无效')
      return { refs: (input.refs || []).map(readReference) }
    },
  },
  folder: {
    title: '文件夹',
    fields: (input, readReference) => ({ binding: input.binding ? readReference(input.binding) : null }),
  },
  clock: { title: '时钟', fields: () => ({}) },
  note: { title: '便签', fields: input => ({ text: typeof input.text === 'string' ? input.text.slice(0, 8192) : '' }) },
}

export const regionTypes = Object.freeze(definitions)
export const regionMenu = Object.freeze(Object.entries(definitions).map(([kind, definition]) => ({ kind, title: definition.title })))
