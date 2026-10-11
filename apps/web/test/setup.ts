import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// findBy* and waitFor wait 1s by default, too tight for a first full render under load
configure({ asyncUtilTimeout: 4000 });
