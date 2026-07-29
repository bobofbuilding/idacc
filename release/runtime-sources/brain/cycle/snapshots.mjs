import { brainPost } from '../brain-client.mjs';

export async function sourcePrecisionSnapshot() {
  const response = await brainPost('/brain/source-precision-snapshot', {
    days: Number(process.env.BRAIN_CYCLE_PRECISION_SNAPSHOT_DAYS ?? 90),
    source: 'brain-cycle',
  }, { strict: false });
  return response.data?.snapshot ?? null;
}

export async function instructionScopeSnapshot() {
  const response = await brainPost('/brain/instruction-scope-snapshot', {
    source: 'brain-cycle',
  }, { strict: false });
  return response.data?.snapshot ?? null;
}
