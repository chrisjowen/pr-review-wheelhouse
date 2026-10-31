import js from '@eslint/js';
import globals from 'globals';

export default [
	{ ignores: ['node_modules/'] },
	js.configs.recommended,
	{
		files: [
			'wheelhouse/server/**/*.js',
			'wheelhouse/engine/**/*.js',
			'test/**/*.js',
			'eslint.config.js'
		],
		languageOptions: { globals: globals.node }
	},
	{
		files: ['wheelhouse/ui/**/*.js', 'test/ui.test.js'],
		languageOptions: { globals: globals.browser }
	}
];
