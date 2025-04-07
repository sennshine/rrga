import numpy as np
import json

# Grid settings for GFS 0.25 degree
nx, ny = 1440, 721
lo1, la1 = 0.0, 90.0
lo2, la2 = 359.75, -90.0
dx, dy = 0.25, 0.25

# Load .bin wind files
u = np.fromfile("ugrd10_f003.bin", dtype='float32').reshape((ny, nx)).tolist()
v = np.fromfile("vgrd10_f003.bin", dtype='float32').reshape((ny, nx)).tolist()

# Format for WindGL
wind_data = {
    "header": {
        "nx": nx,
        "ny": ny,
        "lo1": lo1,
        "la1": la1,
        "lo2": lo2,
        "la2": la2,
        "dx": dx,
        "dy": dy,
        "refTime": "2025-04-05T12:00Z"
    },
    "data": {
        "u": u,
        "v": v
    }
}

# Save as JSON
with open("wind_f003.json", "w") as f:
    json.dump(wind_data, f)

print("✅ wind_f003.json created.")
