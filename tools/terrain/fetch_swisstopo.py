"""Download swisstopo elevation (swissALTI3D, 2 m) and aerial photos (SWISSIMAGE, 2 m) for a map area.

Tiles are 1 km squares named by their LV95 corner in km (e.g. 2784-1152). Raw files go to
terrain-raw/<area>/ (not committed); re-run to resume, finished files are skipped.

    python3 tools/terrain/fetch_swisstopo.py engadin
"""
import json, os, sys, urllib.request, concurrent.futures as cf

# LV95 extents in km: (east_min, east_max, north_min, north_max)
AREAS = {
    'engadin': (2760, 2800, 1138, 1178),
}
# WGS84 search boxes that cover each LV95 extent with margin (tiles are filtered by id afterwards)
SEARCH = {
    'engadin': (9.40, 46.20, 10.35, 46.85),
}
STAC = 'https://data.geo.admin.ch/api/stac/v0.9/collections/{}/items?bbox={}&limit=100'
SETS = {
    'ch.swisstopo.swissalti3d': lambda k: k.endswith('_2_2056_5728.tif'),
    'ch.swisstopo.swissimage-dop10': lambda k: k.endswith('_2_2056.tif'),
}

def get_json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)

def list_tiles(coll, bbox, ext):
    e0, e1, n0, n1 = ext
    best = {}  # tile -> (year, url): keep the newest survey of each tile
    url = STAC.format(coll, ','.join(map(str, bbox)))
    while url:
        page = get_json(url)
        for f in page['features']:
            tile = f['id'].rsplit('_', 1)[1]
            year = int(f['id'].rsplit('_', 2)[1])
            e, n = map(int, tile.split('-'))
            if not (e0 <= e < e1 and n0 <= n < n1):
                continue
            for k, a in f['assets'].items():
                if SETS[coll](k) and (tile not in best or year > best[tile][0]):
                    best[tile] = (year, a['href'])
        url = next((l['href'] for l in page['links'] if l['rel'] == 'next'), None)
    return best

def fetch(url, path):
    if os.path.exists(path):
        return 0
    tmp = path + '.part'
    for attempt in range(4):
        try:
            urllib.request.urlretrieve(url, tmp)
            os.replace(tmp, path)
            return os.path.getsize(path)
        except Exception as err:
            if attempt == 3:
                print('failed', url, err, flush=True)
    return 0

def main(area):
    ext, bbox = AREAS[area], SEARCH[area]
    for coll in SETS:
        out = os.path.join('terrain-raw', area, coll.split('.')[-1])
        os.makedirs(out, exist_ok=True)
        tiles = list_tiles(coll, bbox, ext)
        total = (ext[1] - ext[0]) * (ext[3] - ext[2])
        print(f'{coll}: {len(tiles)} of {total} tiles exist', flush=True)
        jobs = {tile: (url, os.path.join(out, tile + '.tif')) for tile, (_, url) in tiles.items()}
        done = size = 0
        with cf.ThreadPoolExecutor(6) as pool:
            for got in pool.map(lambda j: fetch(*j), jobs.values()):
                done += 1; size += got
                if done % 200 == 0:
                    print(f'  {done}/{len(jobs)}  {size / 1e6:.0f} MB', flush=True)
        print(f'  done, {size / 1e6:.0f} MB new', flush=True)

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'engadin')
