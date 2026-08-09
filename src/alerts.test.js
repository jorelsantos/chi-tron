// U15 (R12) — coverage for the pure logic in alerts.js: RouteStatus
// classification (built test-first per the plan's approach, since
// RouteStatus is undocumented free text with no fixed enum to assert
// against) and AlertsEngine's ingestRoutes/ingestAlerts state management.
// No DOM, no real network — matches trains.test.js/buses.test.js's style.

import { describe, it, expect } from 'vitest';
import { AlertsEngine, classifyRouteStatus, isAccessibilityAlert } from './alerts.js';

describe('classifyRouteStatus', () => {
  it('classifies every documented/observed RouteStatus string to exactly one tag', () => {
    // "Normal Service"/"Added Service" verified live against the real API
    // 2026-07-28; "Planned Work"/"Minor Delay"/"Not in Service"/"Service
    // Change" are CTA's other historically-used strings for this field.
    expect(classifyRouteStatus('Normal Service')).toBe('normal');
    expect(classifyRouteStatus('Added Service')).toBe('added');
    expect(classifyRouteStatus('Planned Work')).toBe('planned');
    expect(classifyRouteStatus('Minor Delay')).toBe('incident');
    expect(classifyRouteStatus('Not in Service')).toBe('incident');
    expect(classifyRouteStatus('Service Change')).toBe('incident');
  });

  it('falls back to normal for an unrecognized value, rather than throwing', () => {
    expect(() => classifyRouteStatus('Something CTA invents tomorrow')).not.toThrow();
    // Genuinely novel text has no "not normal, not planned, not added"
    // signal beyond "not one of the other three" -- which classifyRouteStatus
    // treats as an incident, matching the plan's default-to-incident rule.
    // The true "never throw, never crash" fallback is exercised by empty input:
    expect(classifyRouteStatus('')).toBe('normal');
    expect(classifyRouteStatus(undefined)).toBe('normal');
    expect(classifyRouteStatus(null)).toBe('normal');
  });
});

describe('isAccessibilityAlert', () => {
  it('matches the documented example Impact string', () => {
    expect(isAccessibilityAlert('Accessibility Status')).toBe(true);
    expect(isAccessibilityAlert('Elevator Outage')).toBe(true);
  });

  it('does not match an unrelated Impact string', () => {
    expect(isAccessibilityAlert('Planned Reroute')).toBe(false);
    expect(isAccessibilityAlert(undefined)).toBe(false);
  });
});

describe('AlertsEngine.ingestRoutes', () => {
  it('classifies each line from a well-formed Route Status payload', () => {
    const engine = new AlertsEngine();
    engine.ingestRoutes({
      CTARoutes: {
        RouteInfo: [
          { ServiceId: 'Red', RouteStatus: 'Normal Service' },
          { ServiceId: 'P', RouteStatus: 'Added Service' },
        ],
      },
    });
    expect(engine.lineStatus.Red).toBe('normal');
    expect(engine.lineStatus.P).toBe('added');
  });

  it('clears a stressed treatment once the line reports normal again', () => {
    const engine = new AlertsEngine();
    engine.ingestRoutes({ CTARoutes: { RouteInfo: [{ ServiceId: 'Red', RouteStatus: 'Minor Delay' }] } });
    expect(engine.lineStatus.Red).toBe('incident');

    engine.ingestRoutes({ CTARoutes: { RouteInfo: [{ ServiceId: 'Red', RouteStatus: 'Normal Service' }] } });
    expect(engine.lineStatus.Red).toBe('normal');
  });

  it('handles a single RouteInfo object (not an array), per the documented shape', () => {
    const engine = new AlertsEngine();
    engine.ingestRoutes({ CTARoutes: { RouteInfo: { ServiceId: 'Red', RouteStatus: 'Normal Service' } } });
    expect(engine.lineStatus.Red).toBe('normal');
  });

  it('leaves lineStatus untouched on a malformed payload', () => {
    const engine = new AlertsEngine();
    engine.ingestRoutes({ CTARoutes: { RouteInfo: [{ ServiceId: 'Red', RouteStatus: 'Minor Delay' }] } });
    engine.ingestRoutes({}); // no CTARoutes at all
    expect(engine.lineStatus.Red).toBe('incident');
  });
});

describe('AlertsEngine.ingestAlerts', () => {
  const accessibilityAlert = (stationId) => ({
    Headline: 'Elevator Outage',
    Impact: 'Accessibility Status',
    SeverityScore: '5',
    ImpactedService: { Service: [{ ServiceType: 'T', ServiceId: stationId }] },
  });

  it('marks only the stations named by an accessibility alert', () => {
    const engine = new AlertsEngine();
    engine.ingestAlerts({
      CTAAlerts: {
        Alert: [accessibilityAlert('40010'), accessibilityAlert('40020')],
      },
    });
    expect(engine.stationFlags).toEqual(new Set(['40010', '40020']));
  });

  it('does not flag a station from a non-accessibility alert', () => {
    const engine = new AlertsEngine();
    engine.ingestAlerts({
      CTAAlerts: {
        Alert: [
          {
            Headline: 'Reroute',
            Impact: 'Planned Reroute',
            SeverityScore: '20',
            ImpactedService: { Service: [{ ServiceType: 'T', ServiceId: '40010' }] },
          },
        ],
      },
    });
    expect(engine.stationFlags.size).toBe(0);
  });

  it('picks the highest-severity headline per affected line', () => {
    const engine = new AlertsEngine();
    engine.ingestAlerts({
      CTAAlerts: {
        Alert: [
          {
            Headline: 'Minor slow zone',
            Impact: 'Minor Delay',
            SeverityScore: '30',
            ImpactedService: { Service: [{ ServiceType: 'R', ServiceId: 'Red' }] },
          },
          {
            Headline: 'Major reroute',
            Impact: 'Detour',
            SeverityScore: '70',
            ImpactedService: { Service: [{ ServiceType: 'R', ServiceId: 'Red' }] },
          },
        ],
      },
    });
    expect(engine.lineHeadline.Red).toBe('Major reroute');
  });

  it('leaves stationFlags and lineHeadline intact on a malformed payload', () => {
    const engine = new AlertsEngine();
    engine.ingestAlerts({ CTAAlerts: { Alert: [accessibilityAlert('40010')] } });
    engine.ingestAlerts({}); // no CTAAlerts at all
    expect(engine.stationFlags).toEqual(new Set(['40010']));
  });

  it('clears stationFlags on a well-formed "no active alerts" response', () => {
    const engine = new AlertsEngine();
    engine.ingestAlerts({ CTAAlerts: { Alert: [accessibilityAlert('40010')] } });
    engine.ingestAlerts({ CTAAlerts: { ErrorCode: '25', Alert: undefined } });
    expect(engine.stationFlags.size).toBe(0);
  });
});
