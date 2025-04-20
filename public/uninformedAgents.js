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

async function initializeAgentsOnly() {
  clearAgents(); // Reset any old agents

  const spawnData = await loadAgentSpawnLocations();

  const usedCoords = new Set(); // Track unique coords
  let count = 0;

  for (const agentData of spawnData) {
    if (count >= 50) break;

    const { id, coordinates, region } = agentData;
    const coordKey = JSON.stringify(coordinates);

    if (usedCoords.has(coordKey)) continue;
    usedCoords.add(coordKey);

    const possibleSites = evacuationSites.filter(site =>
      site.area.toLowerCase() === region.toLowerCase()
    );
    if (!possibleSites.length) continue;

    const evacSite = possibleSites[Math.floor(Math.random() * possibleSites.length)];

    const agent = new Agent(id, coordinates, evacSite.coordinates, evacSite.name, region);
    agents.push(agent);
    count++;
  }

  console.log(`✅ Initialized ${agents.length} unique agents`);
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

        this.panicDelay = 0;           // No delay at the start
        this.delayStart = null;        // Will be set only after reroute


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
    
      

      async move() {
        if (this.status === "delayed") {
          const now = Date.now();
          if (this.panicDelay === 0 || (this.delayStart && now - this.delayStart >= this.panicDelay)) {
              this.status = "moving";
              if (!this.startTime) this.startTime = Date.now();
          } else return;
        }
      
    
        if (!this.route.length || this.status === "blocked" || this.status === "arrived") return;
    
        const target = this.route[this.routeIndex];
        if (!target || !Array.isArray(target)) return;
        const [lon, lat] = this.position;
        const [targetLon, targetLat] = target;
    
        // ✅ Turf.js distance (real-world geodesic)
        const from = turf.point(this.position);
        const to = turf.point(target);
        const dist = turf.distance(from, to, { units: 'kilometers' }); 
        this.totalDistance += dist;
    
        const step = 0.000025;
        const dx = targetLon - lon;
        const dy = targetLat - lat;
        const euclideanDist = Math.sqrt(dx * dx + dy * dy);
    
        if (euclideanDist < step) {
            this.position = target;
            this.routeIndex++;
            if (this.routeIndex >= this.route.length) {
              // Check again if the destination is full before finalizing arrival
              const destinationSite = evacuationSites.find(site =>
                  site.name === this.evacuationSiteName && site.area === this.centerName
              );
          
              if (
                destinationSite &&
                Array.isArray(destinationSite.coordinates) &&
                destinationSite.isFull
              ) {
                console.log(`🚫 Agent ${this.id} arrived at a full center. Attempting reroute.`);
                this.triedDestinations.add(JSON.stringify(destinationSite.coordinates));
                await this.checkAndReroute(); // Try to find alternative
                return;
              }
              
          
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
  
      // Check if current destination is full
      const currentSite = evacuationSites.find(site =>
          site.name === this.evacuationSiteName && site.area === this.centerName
      );
  
      if (currentSite && currentSite.isFull) {
          console.log(`🚫 Agent ${this.id} destination is full: ${currentSite.name}`);
          this.triedDestinations.add(JSON.stringify(currentSite.coordinates));
      }
  
      // If blocked or current destination is full, reroute
      if (checkForBlockedRoads([currentPoint]) || (currentSite && currentSite.isFull)) {
          const fallback = evacuationSites
              .filter(site =>
                  site.area.toLowerCase() === this.centerName.toLowerCase() &&
                  !site.isFull &&
                  !this.triedDestinations.has(JSON.stringify(site.coordinates))
              )
              .sort((a, b) => {
                  // Sort by distance to agent
                  const distA = turf.distance(turf.point(this.position), turf.point(a.coordinates));
                  const distB = turf.distance(turf.point(this.position), turf.point(b.coordinates));
                  return distA - distB;
              });
  
          if (fallback.length > 0) {
              const newSite = fallback[0];
              const success = await this.planRoute(newSite.coordinates);
              if (success) {
                console.log(`🔁 Agent ${this.id} rerouted to ${newSite.name}`);
                this.evacuationSiteName = newSite.name;
                this.centerName = newSite.area;
                this.rerouteCount++;
            
                // Apply random delay after rerouting
                this.status = "delayed";
                this.panicDelay = Math.random() * 8000;
                this.delayStart = Date.now();
            
                return;
            }
            
          }
  
          // Retry again after delay
          console.warn(`⚠️ Agent ${this.id} stuck, retrying reroute...`);
          setTimeout(() => this.checkAndReroute(), 7000);
      }
  }
  
    

    visualizeArrival() {
      // ✅ Add occupancy tracking first
      const evacSite = window.evacuationSites.find(site =>
          site.name === this.evacuationSiteName && site.area === this.centerName
      );
      if (evacSite) {
          evacSite.occupancy = (evacSite.occupancy || 0) + 1;
          updateEvacuationCenterStatus(evacSite);  // 🔁 update icon & isFull flag
      }
  
      // 🧍‍♂️ Change agent icon to "arrived"
      // Just update icon — don't add a new marker
      const el = this.marker.getElement();
      el.src = ARRIVED_ICON_URL;

  
      // 📊 Update stats
      const arrivedAgents = agents.filter(a => a.status === "arrived" && a.startTime && a.endTime);
      if (arrivedAgents.length > 0) {
          const totalSeconds = arrivedAgents.reduce((sum, a) => sum + (a.endTime - a.startTime), 0);
          const avg = (totalSeconds / arrivedAgents.length / 1000).toFixed(2);
          const avgElem = document.getElementById('averageTime');
          const distElem = document.getElementById('totalDistance');
          const arrivedCountElem = document.getElementById('arrivedCount');
  
          const totalDistance = arrivedAgents.reduce((sum, a) => sum + a.totalDistance, 0);
          const avgDistance = (totalDistance / arrivedAgents.length).toFixed(2);
  
          if (avgElem) avgElem.textContent = `${avg}s`;
          if (distElem) distElem.textContent = `${avgDistance} km`;
          if (arrivedCountElem) arrivedCountElem.textContent = arrivedAgents.length;
      }
  
      // 🧾 Log to table
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
  const countElem = document.getElementById('arrivedCount');
  if (countElem) countElem.textContent = `0`;

  await Promise.all(agents.map(agent => agent.planRoute(agent.destination)));

  const now = Date.now();
  agents.forEach(agent => {
    if (agent.status === "delayed") {
      agent.status = "moving";
      agent.startTime = now;
    }

    agent.panicDelay = Math.random() * 8000;
    agent.delayStart = null;
  });

  animateAgents(); // start checking movement
}





function startSimTimer() {
    const simTimeElem = document.getElementById('simTime');
    simTimerInterval = setInterval(() => {
      const elapsed = (Date.now() - simulationStartTime) / 1000;
      simTimeElem.textContent = `${elapsed.toFixed(2)}s`;
    }, 500);
  }

function updateEvacuationCenterStatus(site) {
  if (!site.marker) return;

  const el = site.marker.getElement();

  if (site.occupancy >= MAX_CAPACITY) {
    site.isFull = true;
    el.style.backgroundImage = 'url("/red-icon.png")'; // 🔴
  } else if (site.occupancy >= YELLOW_THRESHOLD) {
    site.isFull = false;
    el.style.backgroundImage = 'url("/yellow-icon.png")'; // 🟡
  } else {
    site.isFull = false;
    el.style.backgroundImage = 'url("/gps.png")'; // 🟢 default
  }
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
    if (countElem) countElem.textContent = `0`;
  }
  
let weatherData = [];
let currentWeatherIndex = 0;
let weatherUpdateInterval = null;

async function loadWeatherData() {
  try {
    const response = await fetch('weather_data.json');
    if (!response.ok) throw new Error(`Failed to load weather data: ${response.status}`);
    weatherData = await response.json();
    if (weatherData.length === 0) throw new Error('No weather data found in the JSON file');
    console.log('✅ Weather data loaded:', weatherData);
    return true;
  } catch (error) {
    console.error('💥 Weather loading error:', error);
    alert('Failed to load weather data. See console for details.');
    return false;
  }
}


function updateWeatherTable(index) {
  if (!weatherData || index >= weatherData.length) return;

  const data = weatherData[index];
  document.getElementById('rainfall').textContent = data['precipitation_mm/hr'];
  document.getElementById('humidity').textContent = data['humidity_percent'];
  document.getElementById('pressure').textContent = data['pressure_hPa'];

  const table = document.getElementById('weather-info-table');
  const floodWarning = document.getElementById('flood-warning');

  if (data['flood_alert']) {
      table.classList.add('weather-warning');
      floodWarning.style.display = 'block';

      if (index === 1 && !simulationRunning) {
          simulationRunning = true;
          initAgentSimulation();  // Start agents here
      }
  } else {
      table.classList.remove('weather-warning');
      floodWarning.style.display = 'none';
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  const loaded = await loadWeatherData();
  if (loaded) {
    updateWeatherTable(0); // Show first row immediately
  }
  await initializeAgentsOnly();

});




function startWeatherUpdates() {
  currentWeatherIndex = 1;

  // ⏳ Start simulation + weather updates after 3s
  setTimeout(() => {
    updateWeatherTable(currentWeatherIndex);

    weatherUpdateInterval = setInterval(() => {
      currentWeatherIndex++;
      if (currentWeatherIndex < weatherData.length) {
        updateWeatherTable(currentWeatherIndex);
      } else {
        clearInterval(weatherUpdateInterval);
      }
    }, 5000);
  }, 3000); // start weather updates

  // ⏳ After 5s (from button click), start agent movement
  setTimeout(() => {
    simulationRunning = true;
    initAgentSimulation(); // this should directly begin movement
  }, 5000);
}




function showMetricsSummary() {
    const results = agents.map(agent => agent.getMetrics());
    console.table(results);


    if (simTimerInterval) {
      clearInterval(simTimerInterval);
      simTimerInterval = null;
    }

}

const closeBtn = document.getElementById("closeModalBtn");
const modal = document.getElementById("completionModal");

closeBtn.onclick = () => {
  modal.style.display = "none";
};

// Optional: Close on outside click
window.onclick = (e) => {
  if (e.target === modal) {
    modal.style.display = "none";
  }
};

document.getElementById("startBtn").addEventListener("click", () => {
  if (!simulationRunning && weatherData.length > 1) {
    simulationRunning = true;

    simulationStartTime = Date.now(); // ✅ Timer begins right here
    startSimTimer(); // ✅ Start updating UI clock

    revealEvacuationSites();
    revealRoadblocks();

    // ⏳ Delay weather start by 3s
    setTimeout(() => {
      startWeatherUpdates(); // Weather updates start
    }, 3000);

    // ⏳ Delay agent movement by 5s
    setTimeout(() => {
      animateAgents(); // ⏳ Start moving agents after 5s
    
      // ⏱ Timeout after 45s from button click
      setTimeout(() => {
        if (simulationRunning) {
          simulationRunning = false;
          if (animationFrameId) cancelAnimationFrame(animationFrameId);
          if (simTimerInterval) clearInterval(simTimerInterval);
          showTimedOutSummary();
        }
      }, 45000);
    }, 5000); // Delay agent movement
    

    // Roadblocks + Evac markers
    window.roadClosures.forEach(road => {
      drawBlockedRoad(road);
      addRoadblockMarker(road.start);
      addRoadblockMarker(road.end);
    });

    window.evacuationSites.forEach(site => {
      const el = document.createElement('div');
      el.className = 'evacuation-center-marker';
      el.style.width = '40px';
      el.style.height = '40px';
      el.style.backgroundSize = 'cover';
      el.style.backgroundRepeat = 'no-repeat';
      el.style.backgroundPosition = 'center';
      el.style.backgroundImage = 'url("/gps.png")';
      el.style.opacity = 0;
      const marker = new mapboxgl.Marker(el)
        .setLngLat(site.coordinates)
        .setPopup(new mapboxgl.Popup().setText(site.name))
        .addTo(map);
      site.marker = marker;
    });

    // Start weather + agents after delay
    startWeatherUpdates();
  }
});





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
    <p><strong>Simulation timed out after 45s</strong></p>
    <p><strong>Evacuation Success Rate:</strong> ${successRate}%</p>
    <p><strong>Average Time Taken:</strong> ${avgTime} seconds</p>
    <p><strong>Average Distance Travelled:</strong> ${avgDistance} km</p>
  `;

  modal.style.display = "flex";
}

document.getElementById("stopBtn").addEventListener("click", () => {
    simulationRunning = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
});

map.on('load', async () => {
  // Add route source and layer
  map.addSource('route', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [] }
    }
  });

  map.addLayer({
    id: 'route',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ff0000', 'line-width': 5 }
  });

  // 👇 Initialize agents to appear before simulation
  await initializeAgentsOnly(); 
});

function fadeInElement(element, delay = 0) {
  element.style.opacity = 0;
  element.style.transition = 'opacity 10s ease';
  setTimeout(() => {
    element.style.opacity = 1;
  }, delay);
}

// Gradually show evacuation sites
function revealEvacuationSites() {
  window.evacuationSites.forEach((site, index) => {
    if (site.marker) {
      const el = site.marker.getElement();
      el.style.opacity = 0; // Start hidden
      el.style.transition = 'opacity 10s ease';
      setTimeout(() => {
        el.style.opacity = 1;
      }, index * 5000); // Delay each one a bit
    }
  });
}

// Gradually show roadblocks (assuming each roadblock has its own layer with id starting with 'roadblock-')
function revealRoadblocks() {
  const roadLayers = map.getStyle().layers.filter(layer => layer.id.startsWith('roadblock-'));
  roadLayers.forEach((layer, index) => {
    map.setLayoutProperty(layer.id, 'visibility', 'none');
    setTimeout(() => {
      map.setLayoutProperty(layer.id, 'visibility', 'visible');
    }, index * 300);
  });
}


