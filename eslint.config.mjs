import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextVitals,
  {
    // eslint-config-next 16.2+ ships React Compiler hook rules as errors.
    // FlatCompat cannot load that config under ESLint 8 (circular JSON crash),
    // so we use the native flat export and keep the compiler rules off until
    // the app is migrated. Classic rules-of-hooks / exhaustive-deps stay on.
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/use-memo": "off",
    },
  },
];

export default eslintConfig;
