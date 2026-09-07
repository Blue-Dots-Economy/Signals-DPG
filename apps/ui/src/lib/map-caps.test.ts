import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  capForZoom,
  resolveClusteredMarkerCap,
  resolveIndividualMarkerCap,
  resolveClusterDisableZoomEnv,
  SEARCH_AREA_MIN_ZOOM,
} from './map-caps';
import { DEFAULT_CLUSTER_DISABLE_ZOOM } from './map-viewport-snap';
import * as runtimeEnv from './runtime-env';

/** Stub `getRuntimeEnv` (the runtime-env source the caps now read) so a test
 * can inject a per-key value; any key not in `values` resolves to undefined
 * (i.e. falls back to the default), mirroring an unset deployment. */
function mockRuntimeEnv(values: Record<string, string | undefined>) {
  vi.spyOn(runtimeEnv, 'getRuntimeEnv').mockImplementation(
    ((k: string) => values[k]) as unknown as typeof runtimeEnv.getRuntimeEnv,
  );
}

describe('capForZoom', () => {
  it('returns the clustered cap (1000) below the cluster-disable zoom', () => {
    expect(capForZoom(DEFAULT_CLUSTER_DISABLE_ZOOM - 1)).toBe(1000);
    expect(capForZoom(0)).toBe(1000);
  });

  it('returns the individual cap (500) at/above the cluster-disable zoom', () => {
    expect(capForZoom(DEFAULT_CLUSTER_DISABLE_ZOOM)).toBe(500);
    expect(capForZoom(DEFAULT_CLUSTER_DISABLE_ZOOM + 4)).toBe(500);
  });

  it('honors an explicit cluster-disable-zoom override', () => {
    expect(capForZoom(9, { clusterDisableZoom: 10 })).toBe(1000);
    expect(capForZoom(10, { clusterDisableZoom: 10 })).toBe(500);
  });

  it('honors explicit cap overrides', () => {
    expect(capForZoom(0, { clusteredCap: 2000 })).toBe(2000);
    expect(capForZoom(20, { individualCap: 250 })).toBe(250);
  });
});

describe('runtime-env overrides (VITE_MAP_MARKER_CAP_CLUSTERED / _INDIVIDUAL / VITE_MAP_CLUSTER_DISABLE_ZOOM)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveClusteredMarkerCap reads VITE_MAP_MARKER_CAP_CLUSTERED, falling back to 1000', () => {
    mockRuntimeEnv({});
    expect(resolveClusteredMarkerCap()).toBe(1000);
    mockRuntimeEnv({ VITE_MAP_MARKER_CAP_CLUSTERED: '2500' });
    expect(resolveClusteredMarkerCap()).toBe(2500);
  });

  it('resolveIndividualMarkerCap reads VITE_MAP_MARKER_CAP_INDIVIDUAL, falling back to 500', () => {
    mockRuntimeEnv({});
    expect(resolveIndividualMarkerCap()).toBe(500);
    mockRuntimeEnv({ VITE_MAP_MARKER_CAP_INDIVIDUAL: '750' });
    expect(resolveIndividualMarkerCap()).toBe(750);
  });

  it('resolveClusterDisableZoomEnv reads VITE_MAP_CLUSTER_DISABLE_ZOOM, falling back to 14', () => {
    mockRuntimeEnv({});
    expect(resolveClusterDisableZoomEnv()).toBe(14);
    mockRuntimeEnv({ VITE_MAP_CLUSTER_DISABLE_ZOOM: '16' });
    expect(resolveClusterDisableZoomEnv()).toBe(16);
  });

  it('ignores an invalid/empty/non-positive override and falls back to the default', () => {
    mockRuntimeEnv({ VITE_MAP_MARKER_CAP_CLUSTERED: '' });
    expect(resolveClusteredMarkerCap()).toBe(1000);
    mockRuntimeEnv({ VITE_MAP_MARKER_CAP_CLUSTERED: 'not-a-number' });
    expect(resolveClusteredMarkerCap()).toBe(1000);
    mockRuntimeEnv({ VITE_MAP_MARKER_CAP_CLUSTERED: '-5' });
    expect(resolveClusteredMarkerCap()).toBe(1000);
  });
});

describe('SEARCH_AREA_MIN_ZOOM', () => {
  it('sits at street level, not city level', () => {
    // Regression: at 10 the whole of Bengaluru fit on screen and "Search this
    // area" was still offered. Filtering a list to a whole metro is
    // indistinguishable from not filtering it, so the button read as noise.
    // 15 is where Google's tiles start naming individual streets.
    expect(SEARCH_AREA_MIN_ZOOM).toBeGreaterThanOrEqual(15);
  });

  it('is above the zoom where clusters break apart', () => {
    // The rectangle should only be offered once the viewer can see the
    // individual markers it would keep, rather than a cluster bubble standing
    // in for an unknown number of them.
    expect(SEARCH_AREA_MIN_ZOOM).toBeGreaterThan(DEFAULT_CLUSTER_DISABLE_ZOOM);
  });
});
