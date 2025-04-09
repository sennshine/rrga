const AGENT_ICON_URL = 'red-person.png';
const ARRIVED_ICON_URL = 'green-person.png';
const AGENT_COUNT = 20;

const REGIONS = {
    Beaufort: { name: "Beaufort", bbox: [115.69, 5.33, 115.76, 5.41] },
    Keningau: { name: "Keningau", bbox: [116.15, 5.32, 116.27, 5.47] },
    Tenom: { name: "Tenom", bbox: [115.93, 5.11, 116.00, 5.13] }
};

function randomPositionInRegion(region) {
    const [minLon, minLat, maxLon, maxLat] = region.bbox;
    const lon = minLon + Math.random() * (maxLon - minLon);
    const lat = minLat + Math.random() * (maxLat - minLat);
    return [lon, lat];
}

function checkForBlockedRoads(routeCoords) {
    if (!Array.isArray(routeCoords)) return true;
    return routeCoords.some(coord => isRoadBlockedAt(coord)); // You must define this elsewhere
}

async function loadAgentSpawnLocations() {
    const response = await fetch('agent_locations.json');
    const data = await response.json();
    return data;
}


let agents = [];
let animationFrameId = null;
let simulationRunning = false;

class Agent {
    constructor(id, start, destination, evacuationSiteName, centerName) {
        this.id = id;
        this.position = [...start];
        this.destination = destination;
        this.evacuationSiteName = evacuationSiteName;
        this.centerName = centerName;

        this.status = "delayed";
        this.hasRerouted = false;
        this.route = [];
        this.routeIndex = 0;

        this.panicDelay = Math.random() * 5000;
        this.delayStart = Date.now();

        this.startTime = null;
        this.endTime = null;
        this.rerouteCount = 0;
        this.totalDistance = 0;

        this.triedDestinations = new Set();

        this.marker = new mapboxgl.Marker({
            element: this.createIcon(),
            rotationAlignment: 'map',
        }).setLngLat(this.position).addTo(map);
    }

    createIcon(isArrived = false) {
        const img = document.createElement('img');
        img.src = isArrived ? ARRIVED_ICON_URL : AGENT_ICON_URL;
        img.alt = isArrived ? "arrived" : "evacuating";
        img.style.width = '30px';
        img.style.height = '30px';
        img.style.objectFit = 'contain';
        return img;
    }

    async planRoute(destination = this.destination) {
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${this.position[0]},${this.position[1]};${destination[0]},${destination[1]}?geometries=geojson&alternatives=true&access_token=${mapboxgl.accessToken}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.routes && data.routes.length > 0) {
            for (let route of data.routes) {
                const coords = route.geometry.coordinates;
                if (!checkForBlockedRoads(coords)) {
                    this.route = coords;
                    this.routeIndex = 0;
                    this.destination = destination;
                    this.triedDestinations.clear();
                    return true;
                }
            }
        }
        return false;
    }

    move() {
        if (this.status === "delayed") {
            const now = Date.now();
            if (now - this.delayStart >= this.panicDelay) {
                this.status = "moving";
                this.startTime = Date.now();
            } else return;
        }

        if (!this.route.length || this.status === "blocked" || this.status === "arrived") return;

        const target = this.route[this.routeIndex];
        const [lon, lat] = this.position;
        const [targetLon, targetLat] = target;

        const dx = targetLon - lon;
        const dy = targetLat - lat;
        const dist = Math.sqrt(dx * dx + dy * dy);
        this.totalDistance += dist;

        const step = 0.0005;
        if (dist < step) {
            this.position = target;
            this.routeIndex++;
            if (this.routeIndex >= this.route.length) {
                this.status = "arrived";
                this.endTime = Date.now();
                this.visualizeArrival();
                return;
            }
        } else {
            this.position[0] += (dx / dist) * step;
            this.position[1] += (dy / dist) * step;
        }

        this.marker.setLngLat(this.position);
    }

    async checkAndReroute() {
        if (this.status !== "moving") return;
        if (!this.route || this.routeIndex >= this.route.length) return;

        const point = this.route[this.routeIndex];
        if (!point || !Array.isArray(point)) return;

        if (!checkForBlockedRoads([point])) return;

        this.triedDestinations.add(JSON.stringify(this.destination));
        const success = await this.planRoute(this.destination);

        if (!success) {
            const fallback = evacuationSites.find(site =>
                !this.triedDestinations.has(JSON.stringify(site.coordinates))
            );

            if (fallback) {
                const newSuccess = await this.planRoute(fallback.coordinates);
                if (newSuccess) {
                    console.log(`Agent ${this.id} rerouted to ${fallback.name}`);
                    this.evacuationSiteName = fallback.name;
                    this.centerName = fallback.area;
                    this.rerouteCount++;
                    return;
                }
            }

            setTimeout(() => this.checkAndReroute(), 3000);
        } else {
            this.rerouteCount++;
        }
    }

    visualizeArrival() {
        const newMarker = new mapboxgl.Marker({
          element: this.createIcon(true),
          rotationAlignment: 'map',
        }).setLngLat(this.position).addTo(map);
      
        this.marker.remove();
        this.marker = newMarker;
      
        // Update Arrived count
        const countElem = document.getElementById('arrivedCount');
        if (countElem) {
          const current = parseInt(countElem.textContent.split(': ')[1]);
          countElem.textContent = `Arrived: ${current + 1}`;
        }
      
        // Append to top-right table
        const table = document.getElementById('arrivalTableBody');
        if (table) {
          const row = document.createElement('tr');
          row.innerHTML = `
            <td>${this.id}</td>
            <td>${this.centerName}</td>
            <td>${((this.endTime - this.startTime) / 1000).toFixed(2)}s</td>
            <td>${this.totalDistance.toFixed(4)}</td>
          `;
          table.appendChild(row);
        }
      }
      

    removeMarker() {
        this.marker.remove();
    }

    getMetrics() {
        return {
            id: this.id,
            status: this.status,
            timeTaken: this.endTime && this.startTime ? ((this.endTime - this.startTime) / 1000).toFixed(2) + 's' : "N/A",
            reroutes: this.rerouteCount,
            distance: this.totalDistance.toFixed(5)
        };
    }
}

async function initAgentSimulation() {
    clearAgents();

    const countElem = document.getElementById('arrivedCount');
    if (countElem) countElem.textContent = `Arrived: 0`;

    const spawnData = await loadAgentSpawnLocations();

    for (const agentData of spawnData) {
        const { id, coordinates, region } = agentData;

        // Filter evacuation sites by region
        const possibleSites = evacuationSites.filter(site => site.area === region);
        const evacSite = possibleSites[Math.floor(Math.random() * possibleSites.length)];

        const agent = new Agent(id, coordinates, evacSite.coordinates, evacSite.name, region);
        await agent.planRoute();
        agents.push(agent);
    }

    animateAgents();
}


function animateAgents() {
    let allDone = true;

    agents.forEach(async agent => {
        if (agent.status === "moving" || agent.status === "delayed") {
            allDone = false;
            agent.move();
            await agent.checkAndReroute();
        }
    });

    if (!allDone) {
        animationFrameId = requestAnimationFrame(animateAgents);
    } else {
        showMetricsSummary();
    }
}

function clearAgents() {
    agents.forEach(agent => agent.removeMarker());
    agents = [];
  
    const table = document.getElementById('arrivalTableBody');
    if (table) table.innerHTML = '';
  
    const countElem = document.getElementById('arrivedCount');
    if (countElem) countElem.textContent = `Arrived: 0`;
  }
  

function showMetricsSummary() {
    const results = agents.map(agent => agent.getMetrics());
    console.table(results);
}

document.getElementById("startBtn").addEventListener("click", () => {
    if (!simulationRunning) {
        simulationRunning = true;
        initAgentSimulation();
    }
});

document.getElementById("stopBtn").addEventListener("click", () => {
    simulationRunning = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
});
