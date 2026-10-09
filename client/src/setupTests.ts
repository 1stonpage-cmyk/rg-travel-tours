import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { resetTrpcMock } from './__tests__/helpers/mock-trpc';

afterEach(resetTrpcMock);
