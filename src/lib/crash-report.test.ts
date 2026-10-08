import { describe, expect, it } from 'vitest';
import { composeReport, crashMailto } from './crash-report';

const rejection = { at: '2026-10-08T10:00:00Z', kind: 'rejection' as const, text: 'TypeError: x' };
const fatal = { at: '2026-10-08T10:01:00Z', kind: 'fatal' as const, text: 'Error: render' };

describe('composeReport', () => {
  it('asks about nothing when only rejections were seen', () => {
    expect(composeReport(null, [rejection], '1.0.0', 'UA')).toBeNull();
  });

  it('reports a native crash, or a fatal one with its context', () => {
    expect(composeReport('java.lang.NullPointerException', [], '1.0.0', 'UA')).toContain(
      'NullPointerException'
    );
    const report = composeReport(null, [rejection, fatal], '1.0.0', 'UA')!;
    expect(report).toContain('Nearside 1.0.0');
    expect(report.indexOf('TypeError: x')).toBeLessThan(report.indexOf('Error: render'));
  });
});

describe('crashMailto', () => {
  it('encodes the body and caps its length', () => {
    const url = crashMailto('a&b\n' + 'x'.repeat(10_000), 100);
    expect(url).toMatch(/^mailto:[^?]+\?subject=Nearside%20crash%20report&body=a%26b%0A/);
    expect(decodeURIComponent(url.split('body=')[1]).length).toBeLessThanOrEqual(102);
  });
});
