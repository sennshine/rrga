const AGENT_ICON_URL = 'red-person.png';
const ARRIVED_ICON_URL = 'green-person.png';
let simulationStartTime = null;
let simTimerInterval = null;



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
        img.style.width = '20px';
        img.style.height = '20px';
        img.style.objectFit = 'contain';
        return img;
    }

    async planRoute(destination = this.destination) {
        try {
          const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${this.position[0]},${this.position[1]};${destination[0]},${destination[1]}?geometries=geojson&alternatives=true&access_token=${mapboxgl.accessToken}`;
          console.log(`🔍 Agent ${this.id} requesting route:\n${url}`);
      
          const res = await fetch(url);
      
          if (!res.ok) {
            const errorText = await res.text();
            console.error(`❌ Agent ${this.id} fetch failed: ${res.status} - ${errorText}`);
            return false;
          }
      
          const data = await res.json();
      
          if (data.routes && data.routes.length > 0) {
            this.route = data.routes[0].geometry.coordinates;
            this.routeIndex = 0;
            this.destination = destination;
            return true;
          } else {
            console.warn(`⚠️ Agent ${this.id} received no valid routes`);
            return false;
          }
        } catch (error) {
          console.error(`💥 Agent ${this.id} planRoute() error:`, error);
          return false;
        }
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
    
        // ✅ Turf.js distance (real-world geodesic)
        const from = turf.point(this.position);
        const to = turf.point(target);
        const dist = turf.distance(from, to, { units: 'kilometers' }); 
        this.totalDistance += dist;
    
        const step = 0.0005;
        const dx = targetLon - lon;
        const dy = targetLat - lat;
        const euclideanDist = Math.sqrt(dx * dx + dy * dy);
    
        if (euclideanDist < step) {
            this.position = target;
            this.routeIndex++;
            if (this.routeIndex >= this.route.length) {
                this.status = "arrived";
                this.endTime = Date.now();
                this.visualizeArrival();
                return;
            }
        } else {
            this.position[0] += (dx / euclideanDist) * step;
            this.position[1] += (dy / euclideanDist) * step;
        }
    
        this.marker.setLngLat(this.position);
    }

    async checkAndReroute() {
        if (this.status !== "moving") return;
        if (!this.route || this.routeIndex >= this.route.length) return;
    
        const currentPoint = this.route[this.routeIndex];
    
        // Only reroute if the current point is near a roadblock
        if (checkForBlockedRoads([currentPoint])) {
            console.log(`Agent ${this.id} encountered a road block.`);
    
            this.triedDestinations.add(JSON.stringify(this.destination));
            const success = await this.planRoute(this.destination);
    
            if (!success) {
                // Try a new site
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
    
                // Retry later
                console.warn(`Agent ${this.id} stuck — retrying reroute in 3s...`);
                setTimeout(() => this.checkAndReroute(), 3000);
            } else {
                this.rerouteCount++;
            }
        }
    }
    

    visualizeArrival() {
        const newMarker = new mapboxgl.Marker({
          element: this.createIcon(true),
          rotationAlignment: 'map',
        }).setLngLat(this.position).addTo(map);
      
        this.marker.remove();
        this.marker = newMarker;
      
        // Update Average Time in UI
        const arrivedAgents = agents.filter(a => a.status === "arrived" && a.startTime && a.endTime);
        if (arrivedAgents.length > 0) {
          const totalSeconds = arrivedAgents.reduce((sum, a) => sum + (a.endTime - a.startTime), 0);
          const avg = (totalSeconds / arrivedAgents.length / 1000).toFixed(2);
          const avgElem = document.getElementById('averageTime');
          const distElem = document.getElementById('totalDistance');
          const arrivedCountElem = document.getElementById('arrivedCount');

          if (avgElem || distElem) {
            const arrivedAgents = agents.filter(a => a.status === "arrived" && a.startTime && a.endTime);
            const totalSeconds = arrivedAgents.reduce((sum, a) => sum + (a.endTime - a.startTime), 0);
            const totalDistance = arrivedAgents.reduce((sum, a) => sum + a.totalDistance, 0);

            const avg = (totalSeconds / arrivedAgents.length / 1000).toFixed(2);
            const avgDistance = (totalDistance / arrivedAgents.length).toFixed(2);

            if (avgElem) avgElem.textContent = `${avg}s`;
            if (distElem) distElem.textContent = `${avgDistance} km`;
            if (arrivedCountElem) arrivedCountElem.textContent = arrivedAgents.length;
          }
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

    simulationStartTime = Date.now();
    startSimTimer();

    const countElem = document.getElementById('arrivedCount');
    if (countElem) countElem.textContent = `Arrived: 0`;

    const spawnData = await loadAgentSpawnLocations();

    for (const agentData of spawnData) {
        const { id, coordinates, region } = agentData;

        // Filter evacuation sites by region
        const possibleSites = evacuationSites.filter(site => site.area.toLowerCase() === region.toLowerCase());
        if (!possibleSites.length) {
          console.warn(`⚠️ No evacuation site found for region: ${region} (Agent ID: ${id})`);
          continue; // Skip this agent if no matching site
        }
        const evacSite = possibleSites[Math.floor(Math.random() * possibleSites.length)];

        const agent = new Agent(id, coordinates, evacSite.coordinates, evacSite.name, region);
        await agent.planRoute();
        agents.push(agent);

    }
    setTimeout(() => {
        if (simulationRunning) {
          simulationRunning = false;
          if (animationFrameId) cancelAnimationFrame(animationFrameId);
          if (simTimerInterval) clearInterval(simTimerInterval);
          showTimedOutSummary(); // ⬅️ new function
        }
      }, 60000); // 60,000ms = 60 seconds

    animateAgents();
}

function startSimTimer() {
    const simTimeElem = document.getElementById('simTime');
    simTimerInterval = setInterval(() => {
      const elapsed = (Date.now() - simulationStartTime) / 1000;
      simTimeElem.textContent = `${elapsed.toFixed(2)}s`;
    }, 500);
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
        showSimulationCompleteModal(); // 🎯 Trigger modal
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

function showSimulationCompleteModal() {
    const modal = document.getElementById("completionModal");
    modal.style.display = "flex";
  
    const closeBtn = document.getElementById("closeModalBtn");
    closeBtn.onclick = () => {
      modal.style.display = "none";
    };

    if (simTimerInterval) {
        clearInterval(simTimerInterval);
        simTimerInterval = null;
      }
  
    // Optional: Close on outside click
    window.onclick = (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
      }
    };
  }

function showTimedOutSummary() {
  const modal = document.getElementById("completionModal");
  const summaryElem = document.getElementById("modalSummary");

  const arrivedAgents = agents.filter(a => a.status === "arrived" && a.startTime && a.endTime);
  const successRate = (arrivedAgents.length / agents.length * 100).toFixed(2);

  const totalSeconds = arrivedAgents.reduce((sum, a) => sum + (a.endTime - a.startTime), 0);
  const totalDistance = arrivedAgents.reduce((sum, a) => sum + a.totalDistance, 0);

  const avgTime = arrivedAgents.length > 0 ? (totalSeconds / arrivedAgents.length / 1000).toFixed(2) : "N/A";
  const avgDistance = arrivedAgents.length > 0 ? (totalDistance / arrivedAgents.length).toFixed(2) : "N/A";

  summaryElem.innerHTML = `
    <p><strong>⏱ Simulation timed out after 60s</strong></p>
    <p>✅ <strong>Evacuation Success Rate:</strong> ${successRate}%</p>
    <p>🕒 <strong>Average Time Taken:</strong> ${avgTime} seconds</p>
    <p>📏 <strong>Average Distance Travelled:</strong> ${avgDistance} km</p>
  `;

  modal.style.display = "flex";
}

document.getElementById("stopBtn").addEventListener("click", () => {
    simulationRunning = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
});
