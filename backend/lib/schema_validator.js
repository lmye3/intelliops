'use strict';

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateSchema(schema, value, location = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowedTypes.length && !allowedTypes.some(type => typeMatches(value, type))) {
    return [`${location} 类型应为 ${allowedTypes.join('|')}`];
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) errors.push(`${location} 必须等于 ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${location} 不在允许枚举中`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${location} 小于最小值 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${location} 大于最大值 ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${location} 长度不足`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${location} 长度超限`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${location} 项数不足`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${location} 项数超限`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${location} 含重复项`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, `${location}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${location}.${key} 缺失`);
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) errors.push(`${location}.${key} 不允许出现`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) errors.push(...validateSchema(childSchema, value[key], `${location}.${key}`));
    }
  }
  return errors;
}

function assertSchema(schema, value, label = 'payload') {
  const errors = validateSchema(schema, value);
  if (errors.length) {
    const error = new TypeError(`${label} 结构校验失败: ${errors.slice(0, 8).join('; ')}`);
    error.code = 'SCHEMA_VALIDATION_FAILED';
    error.validation_errors = errors;
    throw error;
  }
  return value;
}

module.exports = { validateSchema, assertSchema };
