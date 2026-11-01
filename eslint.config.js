import parser from '@typescript-eslint/parser'

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser },
    rules: {
      'no-debugger': 'error',
      'no-control-regex': 'error',
      'no-duplicate-imports': 'error',
      'no-var': 'error',
    },
  },
]
