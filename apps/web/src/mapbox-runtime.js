export const MAPBOX_BASE_STYLE = 'mapbox://styles/mapbox/dark-v11';

export async function loadMapbox() {
  return import('mapbox-gl');
}
