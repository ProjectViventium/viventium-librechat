/* === VIVENTIUM START === Preset Env owns browser fallbacks and Autoprefixer once. === */
module.exports = {
  plugins: [require('postcss-import'), require('postcss-preset-env'), require('tailwindcss')],
};
/* === VIVENTIUM END === */
