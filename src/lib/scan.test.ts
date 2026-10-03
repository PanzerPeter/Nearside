import { describe, expect, it } from 'vitest';
import { cameraFailure, scanCrop } from './scan';

describe('cameraFailure', () => {
  // getUserMedia rejects with a DOMException; only its name says why.
  const named = (name: string) => Object.assign(new Error(name), { name });

  it('reads a refusal as a refusal', () => {
    expect(cameraFailure(named('NotAllowedError'))).toBe('permission-denied');
  });

  it('reads a missing camera as a missing camera', () => {
    expect(cameraFailure(named('NotFoundError'))).toBe('no-camera');
    expect(cameraFailure(named('OverconstrainedError'))).toBe('no-camera');
  });

  it('reads a browser without capture as unsupported', () => {
    expect(cameraFailure(named('NotSupportedError'))).toBe('unsupported-platform');
  });

  // A camera another app holds is not one this device lacks, and telling
  // somebody mid-call that their phone has no camera would be wrong.
  it('leaves a busy camera a generic failure', () => {
    expect(cameraFailure(named('NotReadableError'))).toBe('error');
    expect(cameraFailure(undefined)).toBe('error');
  });
});

describe('scanCrop', () => {
  it('takes the centre square of a landscape frame', () => {
    expect(scanCrop(1920, 1080)).toEqual({ sx: 420, sy: 0, side: 1080 });
  });

  it('takes the centre square of a portrait frame', () => {
    expect(scanCrop(720, 1280)).toEqual({ sx: 0, sy: 280, side: 720 });
  });
});
