function findNearestEvacuationSite(position) {
    // Sort evacuation sites by direct distance (as the crow flies)
    const sortedSites = evacuationSites.map((site, index) => {
        const distance = Math.sqrt(
            Math.pow(site.coordinates[0] - position[0], 2) + 
            Math.pow(site.coordinates[1] - position[1], 2)
        );
        return { index, distance, isFull: site.isFull };
    })
    // Sort by distance but filter out full sites if any sites are available
    .sort((a, b) => {
        // First check if there are any non-full sites
        const anyNonFull = sortedSites.some(site => !site.isFull);
        
        // If there are non-full sites, prioritize them
        if (anyNonFull) {
            if (a.isFull && !b.isFull) return 1;
            if (!a.isFull && b.isFull) return -1;
        }
        
        // Otherwise sort by distance
        return a.distance - b.distance;
    });
    
    // Return the sorted array of site indices
    return sortedSites.map(site => site.index);
}

async function getRouteForAgent(agent) {
    // Get sorted list of nearest evacuation sites
    const sortedSiteIndices = findNearestEvacuationSite(agent.position);
    
    // Try each evacuation site in order of proximity until we find one without road blocks
    for (const siteIndex of sortedSiteIndices) {
        const site = evacuationSites[siteIndex];
        
        // Skip if the site is already at capacity
        if (site.isFull && agentsStarted) {
            continue;
        }
        
        try {
            // First attempt: Try to get a direct route to the evacuation site
            let routeFound = await tryDirectRoute(agent, site);
            
            // Second attempt if direct route fails: Find nearest road to evacuation site
            if (!routeFound) {
                routeFound = await tryWalkingRoute(agent, site);
            }
            
            if (routeFound) {
                return true;
            }
        } catch (error) {
            console.error(`Error fetching route for agent ${agent.id}:`, error);
        }
    }
    
    // If we get here, no evacuation site can be reached without blockages
    agent.isBlocked = true;
    
    // Show warning icon
    const warningEl = document.getElementById(`warning-${agent.id}`);
    if (warningEl) warningEl.style.display = 'block';
    
    return false;
}

// Function to try getting a direct driving route
async function tryDirectRoute(agent, site, startPosition = null) {
    // Use provided start position or agent's original position
    const start = startPosition || agent.position;
    
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${start[0]},${start[1]};${site.coordinates[0]},${site.coordinates[1]}?geometries=geojson&access_token=${mapboxgl.accessToken}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            const routePoints = route.geometry.coordinates;
            
            // Check if this route has blockages
            if (!checkForBlockedRoads(routePoints)) {
                // Found an unblocked route!
                setupAgentRoute(agent, site, routePoints);
                return true;
            }
        }
        
        return false;
    } catch (error) {
        console.error(`Error fetching direct route for agent ${agent.id}:`, error);
        return false;
    }
}

// Function to find the nearest road to the evacuation site and create a walking route
async function tryWalkingRoute(agent, site, startPosition = null) {
    // Use provided start position or agent's original position
    const start = startPosition || agent.position;
    
    // Try to find a nearby road to the evacuation site
    // We'll search in a small grid around the evacuation site
    const searchPoints = generateSearchPoints(site.coordinates, 0.005, 8);
    
    for (const point of searchPoints) {
        // Try to get a route to this point from agent's position
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${start[0]},${start[1]};${point[0]},${point[1]}?geometries=geojson&access_token=${mapboxgl.accessToken}`;
        
        try {
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.routes && data.routes.length > 0) {
                const route = data.routes[0];
                const routePoints = route.geometry.coordinates;
                
                // Check if this route has blockages
                if (!checkForBlockedRoads(routePoints)) {
                    // Add a walking segment from the road to the evacuation site
                    const walkingRoute = [...routePoints, site.coordinates];
                    
                    // Found a valid route with walking component!
                    setupAgentRoute(agent, site, walkingRoute);
                    return true;
                }
            }
        } catch (error) {
            console.error(`Error fetching walking route for agent ${agent.id}:`, error);
        }
    }
    
    return false;
}

// Function to set up the agent's route information
function setupAgentRoute(agent, site, routePoints) {
    agent.evacuationSite = site;
    agent.evacuationSiteIndex = evacuationSites.indexOf(site);
    agent.routePoints = routePoints;
    agent.currentStep = 0;
    agent.isBlocked = false;
    
    // Update the route visualization on the map
    map.getSource(`route-${agent.id}`).setData({
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'LineString',
            coordinates: agent.routePoints
        }
    });
    
    // Hide warning icon
    const warningEl = document.getElementById(`warning-${agent.id}`);
    if (warningEl) warningEl.style.display = 'none';
}

// Generate search points around a center point to find nearby roads
function generateSearchPoints(center, radius, numPoints) {
    const points = [];
    
    // Add the center point first
    points.push(center);
    
    // Generate points in a circle around the center
    for (let i = 0; i < numPoints; i++) {
        const angle = (i / numPoints) * 2 * Math.PI;
        const x = center[0] + radius * Math.cos(angle);
        const y = center[1] + radius * Math.sin(angle);
        points.push([x, y]);
    }
    
    return points;
}function initMap() {
let arrivedCount = 0;
let totalDistance = 0;
let totalTime = 0;
let weatherData = []; // Will store the loaded weather data
let currentWeatherIndex = 0; // Track which weather data row we're displaying
let weatherUpdateInterval = null; // To store the interval for weather updates
let agentsStarted = false; // Flag to track if agents have started moving
let evacuationCentersVisible = false; // Flag to track if evacuation centers are visible
let evacuationCenterMarkers = []; // Array to store evacuation center markers
let evacuationCenterCapacity = 9; // Maximum capacity per evacuation center
let yellowThreshold = 4; // Centers turn yellow at this many agents

mapboxgl.accessToken = 'pk.eyJ1Ijoid3NuYzAiLCJhIjoiY204eDR2eXM1MDBoeDJrb3RxcWcycGh0MSJ9.RrkeTWJCa3lhoQJsTq_EBQ';
let origin = [115.542913, 5.298978]; 
let destination = null;
let routeLine = null;
let simulationStarted = false;
let agents = [];
let simulationStartTime = 0;
let timerInterval = null;
let landUseTiles = null;
let waterAndMountainPolygons = [];
let consistentAnimationSpeed = 0.00001; // Reduced speed value for slower agent movement
const MAX_AGENTS = 50

// Define boundaries for Sabah area
const sabahBounds = {
    north: 5.6,      // Northern limit
    south: 4.9,      // Southern limit
    west: 115.5,     // Western limit
    east: 116.4      // Eastern limit
};

// All Evacuation Sites
const evacuationSites = [
    { name: "Dewan Selagon", area: "Beaufort", coordinates: [115.73937904860162, 5.398396950885243], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan PSP Dun Banir", area: "Beaufort", coordinates: [115.7334127282223, 5.3549036708753235], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Bisaya", area: "Beaufort", coordinates: [115.7344215639457, 5.361356878354286], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Residensi Prima", area: "Beaufort", coordinates: [115.74818493563325, 5.400393294026437], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Kukut", area: "Beaufort", coordinates: [115.69844738740314, 5.386323384060461], occupancy: 0, isFull: false, marker: null },
    { name: "Pa' Musa Community Hall", area: "Beaufort", coordinates: [115.74714407610811, 5.344622116561316], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan SMK Beaufort 3", area: "Beaufort", coordinates: [115.73122449596387, 5.338514245107157], occupancy: 0, isFull: false, marker: null },
    { name: "Membakut Islamic Arts Hall", area: "Membakut", coordinates: [115.80151432641107, 5.476239557782567], occupancy: 0, isFull: false, marker: null },
    { name: "SMK St. Patrick Membakut", area: "Membakut", coordinates: [115.79418494330773, 5.474439858120865], occupancy: 0, isFull: false, marker: null },
    { name: "Sekolah Kebangsaan Pekan Membakut", area: "Membakut", coordinates: [115.80024204670788, 5.4739517584774235], occupancy: 0, isFull: false, marker: null },
    { name: "DEWAN SMK MEMBAKUT", area: "Membakut", coordinates: [115.80292087158212, 5.4758932752860625], occupancy: 0, isFull: false, marker: null },
    { name: "Masjid Cahaya Iman Membakut", area: "Membakut", coordinates: [115.80205579699727, 5.4756905384269], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Masyarakat Keningau", area: "Sook", coordinates: [116.16125256204798, 5.345185647730118], occupancy: 0, isFull: false, marker: null },
    { name: "Dato Angian Andulag Apin-Apin Hall", area: "Sook", coordinates: [116.2668531160277, 5.466851860631998], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Serbaguna Pekan", area: "Sook", coordinates: [116.15667306985348, 5.337862909569804], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Koningau", area: "Tenom", coordinates: [116.16029769573093, 5.345036097164509], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Arkid", area: "Tenom", coordinates: [116.16046872825626, 5.338115116907178], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Serbaguna Kompleks Sukan Tenom", area: "Tenom", coordinates: [115.94030388777145, 5.118389590836571], occupancy: 0, isFull: false, marker: null },
    { name: "Datuk Seri Panglima Antanom Hall", area: "Tenom", coordinates: [115.94499065651249, 5.1248204892241045], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Perjumpaan Saksi Yehwa Tenom", area: "Tenom", coordinates: [115.94432010068758, 5.123711901762699], occupancy: 0, isFull: false, marker: null },
    { name: "Sri Ontotos Hall", area: "Tenom", coordinates: [115.91934239884245, 4.913805130486194], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Datuk OKK Sanggau Jalang", area: "Tenom", coordinates: [115.99871640311154, 5.2431233197290625], occupancy: 0, isFull: false, marker: null },
    { name: "Sekolah Menengah Saint Anthony Tenom", area: "Tenom", coordinates: [115.9481315742765, 5.130548173640122], occupancy: 0, isFull: false, marker: null },
    { name: "SM Chung Hwa Tenom", area: "Tenom", coordinates: [115.94665796931984, 5.128264646036473], occupancy: 0, isFull: false, marker: null },
    { name: "SK Pekan Tenom", area: "Tenom", coordinates: [115.94563063194656, 5.1273169026898495], occupancy: 0, isFull: false, marker: null },
    { name: "Surau Al Falah", area: "Tenom", coordinates: [115.95205588350234, 5.122043389920686], occupancy: 0, isFull: false, marker: null },
    { name: "Masjid Al-Rahman", area: "Tenom", coordinates: [115.94538232767745, 5.125681776495361], occupancy: 0, isFull: false, marker: null },
    { name: "Kompleks Sukan Tenom", area: "Tenom", coordinates: [115.9405000319466, 5.119091832525258], occupancy: 0, isFull: false, marker: null },
    { name: "Dewan Perniagaan Tionghua", area: "Tenom", coordinates: [115.94500374117237, 5.1230327476119], occupancy: 0, isFull: false, marker: null }
];

const roadClosures = [
    { name: "Jalan Keningau-Kimanis", start: [116.069627, 5.459655], end: [116.097359, 5.395954] },
    { name: "Jalan Mesej Kelanyaan", start: [115.95894, 5.154885], end: [115.966342, 5.173261] },
    { name: "Jalan Pimping", start: [115.781556, 5.48546], end: [115.781662, 5.487937] },
    { name: "Jalan Lumatai", start: [115.731519, 5.3479], end: [115.731164, 5.347975] },
    { name: "Jalan Pak Musa", start: [115.746404, 5.344486], end: [115.746243, 5.344694] }
];

// Load Weather Data
async function loadWeatherData() {
    try {
        const response = await fetch('weather_data.json');
        if (!response.ok) {
            throw new Error(`Failed to load weather data: ${response.status}`);
        }
        
        weatherData = await response.json();
        console.log('Weather data loaded successfully:', weatherData);
        
        if (weatherData.length === 0) {
            throw new Error('No weather data found in the JSON file');
        }
        
        // Update table with initial weather data (first row)
        updateWeatherTable(0);
        
        return true;
    } catch (error) {
        console.error('Error loading weather data:', error);
        showCustomAlert('Failed to load weather data. Please check the console for details.');
        return false;
    }
}

// Update Weather Table
function updateWeatherTable(index) {
    if (!weatherData || index >= weatherData.length) return;
    
    const data = weatherData[index];
    
    // Update table cells
    document.getElementById('rainfall').textContent = data['precipitation_mm/hr'];
    document.getElementById('humidity').textContent = data['humidity_percent'];
    document.getElementById('pressure').textContent = data['pressure_hPa'];
    
    // Check if flood alert is true
    if (data['flood_alert']) {
        document.getElementById('weather-info-table').classList.add('weather-warning');
        document.getElementById('flood-warning').style.display = 'block';
        
        // If this is the second row of data (index 1) and evacuation centers aren't visible yet
        if (index === 1 && !evacuationCentersVisible && simulationStarted) {
            // Display evacuation centers first
            displayEvacuationCenters();
            
            // Start the road closure sequence
            startRoadClosureSequence();
            
            // Wait a moment before starting agent movement (after evacuation centers appear)
            setTimeout(() => {
                startAgentMovement();
            }, 1000); // Wait 1 second to start agent movement after centers appear
        }
    } else {
        document.getElementById('weather-info-table').classList.remove('weather-warning');
        document.getElementById('flood-warning').style.display = 'none';
    }
}

// Start Weather Update Interval
function startWeatherUpdates() {
    if (weatherUpdateInterval) {
        clearInterval(weatherUpdateInterval);
    }
    
    currentWeatherIndex = 0; // Reset to first weather data
    updateWeatherTable(currentWeatherIndex);
    
    // Set interval to update every 3 seconds, stopping at the last entry
    weatherUpdateInterval = setInterval(() => {
        currentWeatherIndex++;
        
        if (currentWeatherIndex < weatherData.length) {
            updateWeatherTable(currentWeatherIndex);
        } else {
            // Stop the interval once we've shown all weather data
            clearInterval(weatherUpdateInterval);
        }
    }, 3000);
}

// Function to start agent movement
function startAgentMovement() {
    if (agentsStarted) return;
    agentsStarted = true;
    
    // Start animation for all agents
    const startTimestamp = performance.now();
    agents.forEach(agent => {
        if (agent.routePoints.length > 0 && !agent.isBlocked) {
            agent.isMoving = true;
            agent.lastStepTime = startTimestamp;
            animateAgentAlongRoute(agent, startTimestamp);
        }
    });
}

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [116.0, 5.3], // Centered on Sabah
    zoom: 9,
    pitch: 30
});

map.addControl(new mapboxgl.NavigationControl());

// Add legend
map.on('load', async () => {
    // Load weather data
    await loadWeatherData();
    
    // Load agent locations data
    await loadAgentLocations();

    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = `
        <h4>Map Legend</h4>
        <div><span class="legend-color" style="background: #3388ff;"></span> Citizens</div>
        <div><span class="legend-color" style="background: #00FF00;"></span> Evacuation Centers</div>
        <div><span class="legend-color" style="background: purple;"></span> Road Closures</div>
        <div><span class="legend-color" style="background: #ff0000;"></span> Evacuation Routes</div>
        <div><span class="legend-color"></span>❗ Agents with Blocked Path</div>
    `;
    document.body.appendChild(legend);
    legend.style.position = 'absolute';
    legend.style.bottom = '30px';
    legend.style.right = '10px';
    
    // Add terrain and water sources
    map.addSource('terrain-data', {
        type: 'vector',
        url: 'mapbox://mapbox.mapbox-terrain-v2'
    });
    
    // Add water layer
    map.addLayer({
        'id': 'water',
        'type': 'fill',
        'source': 'terrain-data',
        'source-layer': 'water',
        'paint': {
            'fill-color': '#69c',
            'fill-opacity': 0.4
        }
    });
    
    // Add mountain layer (hillshade)
    map.addLayer({
        'id': 'hillshade',
        'type': 'fill',
        'source': 'terrain-data',
        'source-layer': 'hillshade',
        'paint': {
            'fill-color': '#5a7',
            'fill-opacity': 0.4
        }
    });
    
    // Add sources and layers
    addSourcesAndLayers();
    addEvacuationSites();
    addRoadClosures();
    
    // Wait for the terrain data to load
    map.once('idle', function() {
        // Generate agents once the terrain data is loaded
        generateAgents(MAX_AGENTS);
    });
});

function addSourcesAndLayers() {
    // Add empty route source and layer for each agent
    for (let i = 0; i < MAX_AGENTS; i++) {
        map.addSource(`route-${i}`, {
            type: 'geojson',
            data: {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: []
                }
            }
        });
        
        map.addLayer({
            id: `route-${i}`,
            type: 'line',
            source: `route-${i}`,
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': '#ff0000',
                'line-width': 3,
                'line-opacity': 0.7
            }
        });
        
        // Add point source for the moving agent
        map.addSource(`point-${i}`, {
            type: 'geojson',
            data: {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Point',
                    coordinates: [0, 0]
                }
            }
        });
        
        map.addLayer({
            id: `point-${i}`,
            type: 'circle',
            source: `point-${i}`,
            paint: {
                'circle-radius': 6,
                'circle-color': '#3388ff',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            }
        });
    }
}


function addEvacuationSites() {
    // We don't add markers at the start - they'll be added when the table turns red
}

// Function to display evacuation centers
function displayEvacuationCenters() {
    if (evacuationCentersVisible) return;
    evacuationCentersVisible = true;
    
    // Create and add markers for each evacuation site
    evacuationSites.forEach((site, index) => {
        // Create marker element with custom color handling
        const el = document.createElement('div');
        el.className = 'evacuation-marker';
        el.style.width = '25px';
        el.style.height = '25px';
        el.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 24 24%22 width%3D%2225%22 height%3D%2225%22%3E%3Cpath fill%3D%22%2300FF00%22 d%3D%22M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z%22%2F%3E%3C%2Fsvg%3E")';
        
        // Create marker
        const marker = new mapboxgl.Marker({
            element: el,
            anchor: 'bottom'
        })
        .setLngLat(site.coordinates)
        .setPopup(new mapboxgl.Popup().setHTML(
            `<strong>${site.name}</strong><br>${site.area}<br>Capacity: ${site.occupancy}/${evacuationCenterCapacity}`
        ))
        .addTo(map);
        
        // Store the marker reference
        site.marker = marker;
    });
}

// Function to update evacuation center color and status based on occupancy
function updateEvacuationCenterStatus(site) {
    if (!site.marker) return;
    
    const el = site.marker.getElement();
    
    // Update popup content
    site.marker.getPopup().setHTML(
        `<strong>${site.name}</strong><br>${site.area}<br>Capacity: ${site.occupancy}/${evacuationCenterCapacity}`
    );
    
    // Update color based on occupancy
    if (site.occupancy >= evacuationCenterCapacity) {
        // Red - full
        el.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 24 24%22 width%3D%2225%22 height%3D%2225%22%3E%3Cpath fill%3D%22%23FF0000%22 d%3D%22M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z%22%2F%3E%3C%2Fsvg%3E")';
        site.isFull = true;
    } else if (site.occupancy >= yellowThreshold) {
        // Yellow - getting full
        el.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 24 24%22 width%3D%2225%22 height%3D%2225%22%3E%3Cpath fill%3D%22%23FFFF00%22 d%3D%22M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z%22%2F%3E%3C%2Fsvg%3E")';
        site.isFull = false;
    } else {
        // Green - available
        el.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 24 24%22 width%3D%2225%22 height%3D%2225%22%3E%3Cpath fill%3D%22%2300FF00%22 d%3D%22M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z%22%2F%3E%3C%2Fsvg%3E")';
        site.isFull = false;
    }
}

function addRoadClosures() {
    // We'll only set up the road closures data here, but not display them initially
    // They will be displayed sequentially when the flood alert starts
}

async function displayRoadClosure(road, index) {
    // Get directions using Mapbox Directions API
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${road.start[0]},${road.start[1]};${road.end[0]},${road.end[1]}?geometries=geojson&access_token=${mapboxgl.accessToken}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            const routePoints = route.geometry.coordinates;
            
            // Add source and layer for this road closure
            if (!map.getSource(road.name)) {
                map.addSource(road.name, {
                    type: 'geojson',
                    data: {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'LineString',
                            coordinates: routePoints
                        }
                    }
                });
                
                map.addLayer({
                    id: road.name,
                    type: 'line',
                    source: road.name,
                    layout: {
                        'line-join': 'round',
                        'line-cap': 'round'
                    },
                    paint: {
                        'line-color': 'purple',
                        'line-width': 5
                    }
                });
                
                // Show a popup with the road name
                const midpoint = routePoints[Math.floor(routePoints.length / 2)];
                new mapboxgl.Popup({ closeButton: false, closeOnClick: false })
                    .setLngLat(midpoint)
                    .setHTML(`<strong>Road closed: ${road.name}</strong>`)
                    .addTo(map)
                    .setMaxWidth("300px");
            }
        }
    } catch (error) {
        console.error(`Error fetching road closure for ${road.name}:`, error);
    }
}

// Function to start displaying road closures sequentially
function startRoadClosureSequence() {
    roadClosures.forEach((road, index) => {
        // Display each road closure with a delay
        setTimeout(() => {
            displayRoadClosure(road, index);
        }, index * 500); // 500ms (0.5 seconds) between each road closure
    });
}

function isPointOnWaterOrMountain(lon, lat) {
    try {
        // Check if the point is on water or mountainous terrain
        const features = map.queryRenderedFeatures(
            map.project([lon, lat]),
            { layers: ['water', 'hillshade'] }
        );
        
        // If features array has items, it means the point is on water or mountain
        return features.length > 0;
    } catch (error) {
        console.error("Error checking terrain type:", error);
        return true; // Default to true (unsafe) in case of error
    }
}


let agentLocationsData = []; // Will hold the loaded JSON data

// Add this function to load the JSON data
async function loadAgentLocations() {
    try {
        const response = await fetch('agent_locations.json');
        if (!response.ok) {
            throw new Error(`Failed to load agent locations: ${response.status}`);
        }
        
        agentLocationsData = await response.json();
        console.log('Agent locations loaded successfully:', agentLocationsData.length);
        
        if (agentLocationsData.length === 0) {
            throw new Error('No agent locations found in the JSON file');
        }
        
        return true;
    } catch (error) {
        console.error('Error loading agent locations:', error);
        showCustomAlert('Failed to load agent locations. Please check the console for details.');
        return false;
    }
}

function generateAgents(count) {
    // Limit the number of agents to what's available in the JSON data
    const agentsToCreate = Math.min(count, agentLocationsData.length);
    
    for (let i = 0; i < agentsToCreate; i++) {
        // Only use locations from JSON
        const position = agentLocationsData[i].coordinates;
        const region = agentLocationsData[i].region;
        
        // Create human marker element with exclamation mark
        const el = createHumanMarkerElement(i);
        
        // Create and add agent
        agents.push({
            id: i,
            position: position,
            region: region,
            marker: new mapboxgl.Marker({
                element: el,
                anchor: 'bottom'
            })
            .setLngLat(position)
            .setPopup(new mapboxgl.Popup().setHTML(
                `<strong>Person ${i+1}</strong><br>Region: ${region}`
            ))
            .addTo(map),
            routePoints: [],
            currentStep: 0,
            evacuationSite: null,
            evacuationSiteIndex: null,
            isMoving: false,
            animationId: null,
            isBlocked: false,
            lastStepTime: 0,
            distanceToNextStep: 0
        });
    }
}

function createHumanMarkerElement(id) {
    const el = document.createElement('div');
    el.className = 'human-marker';
    el.id = `human-${id}`;
    el.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 width%3D%2220%22 height%3D%2220%22 viewBox%3D%220 0 24 24%22%3E%3Cpath fill%3D%22%233388ff%22 d%3D%22M12 2a2.5 2.5 0 0 1 2.5 2.5A2.5 2.5 0 0 1 12 7a2.5 2.5 0 0 1-2.5-2.5A2.5 2.5 0 0 1 12 2zm5.5 10v1H18v7h-3v-7h-6v7H6v-7h.5v-1c0-2.76 2.24-5 5-5s5 2.24 5 5z%22%2F%3E%3C%2Fsvg%3E")';
    
    // Add exclamation mark element (hidden initially)
    const warningEl = document.createElement('div');
    warningEl.className = 'blocked-icon';
    warningEl.id = `warning-${id}`;
    warningEl.innerHTML = '❗';
    warningEl.style.display = 'none';
    el.appendChild(warningEl);
    
    return el;
}

function findNearestEvacuationSite(position) {
    // Sort evacuation sites by direct distance (as the crow flies)
    const sortedSites = evacuationSites.map((site, index) => {
        const distance = Math.sqrt(
            Math.pow(site.coordinates[0] - position[0], 2) + 
            Math.pow(site.coordinates[1] - position[1], 2)
        );
        return { index, distance };
    }).sort((a, b) => a.distance - b.distance);
    
    // Return the sorted array of site indices
    return sortedSites.map(site => site.index);
}

async function getRouteForAgent(agent) {
    // Get sorted list of nearest evacuation sites
    const sortedSiteIndices = findNearestEvacuationSite(agent.position);
    
    // Try each evacuation site in order of proximity until we find one without road blocks
    for (const siteIndex of sortedSiteIndices) {
        const site = evacuationSites[siteIndex];
        
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${agent.position[0]},${agent.position[1]};${site.coordinates[0]},${site.coordinates[1]}?geometries=geojson&access_token=${mapboxgl.accessToken}`;
        
        try {
            const startTime = performance.now();
            const response = await fetch(url);
            const endTime = performance.now();  

            console.log(`API response time for Agent ${agent.id} to ${site.name}: ${(endTime - startTime).toFixed(2)} ms`);
            
            const data = await response.json();
            
            if (data.routes && data.routes.length > 0) {
                const route = data.routes[0];
                const routePoints = route.geometry.coordinates;
                
                // Check if this route has blockages
                if (!checkForBlockedRoads(routePoints)) {
                    // Found an unblocked route!
                    agent.evacuationSite = site;
                    agent.evacuationSiteIndex = siteIndex;
                    agent.routePoints = routePoints;
                    agent.currentStep = 0;
                    agent.isBlocked = false;
                    
                    // Update the route visualization on the map
                    map.getSource(`route-${agent.id}`).setData({
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'LineString',
                            coordinates: agent.routePoints
                        }
                    });
                    
                    // Hide warning icon
                    const warningEl = document.getElementById(`warning-${agent.id}`);
                    if (warningEl) warningEl.style.display = 'none';
                    
                    return true;
                }
            }
        } catch (error) {
            console.error(`Error fetching route for agent ${agent.id}:`, error);
        }
    }
    
    // If we get here, no evacuation site can be reached without blockages
    agent.isBlocked = true;
    
    // Show warning icon
    const warningEl = document.getElementById(`warning-${agent.id}`);
    if (warningEl) warningEl.style.display = 'block';
    
    return false;
}

function checkForBlockedRoads(routePoints) {
    // Don't check for blockages if we haven't displayed the road closures yet
    if (!agentsStarted) return false;
    
    // Buffer distance around road closures (in degrees)
    const bufferDistance = 0.005;
    
    return roadClosures.some(road => {
        // For each road closure, check if any point on the route is within the buffer distance
        const roadStart = road.start;
        const roadEnd = road.end;
        
        for (let i = 0; i < routePoints.length; i++) {
            let [lon, lat] = routePoints[i];
            
            // Check if point is near the road closure
            // Calculate distance from point to road closure
            const point = turf.point([lon, lat]);
            const roadLine = turf.lineString([roadStart, roadEnd]);
            const pointOnLine = turf.nearestPointOnLine(roadLine, point);
            
            // Get distance in km and convert to degrees (roughly)
            // 1 degree ~ 111km at the equator, adjust based on latitude if needed
            const distanceInKm = turf.distance(point, pointOnLine);
            const distanceInDegrees = distanceInKm / 111;
            
            if (distanceInDegrees < bufferDistance) {
                return true;
            }
        }
        return false;
    });
}

// Update the animateAgentAlongRoute function to handle rerouting when evacuation site becomes full
function animateAgentAlongRoute(agent, timestamp) {
    if (!agent.isMoving || agent.isBlocked) return;
    
    // Check if the target evacuation site is full, and reroute if needed
    if (agent.evacuationSite && agent.evacuationSite.isFull && !agent.isRerouting) {
        console.log(`Agent ${agent.id} needs to reroute - evacuation site ${agent.evacuationSite.name} is full`);
        agent.isRerouting = true; // Flag to prevent multiple reroutings
        
        // Find a new route for this agent excluding the current full site
        rerouteAgent(agent).then(success => {
            if (success) {
                console.log(`Agent ${agent.id} successfully rerouted to ${agent.evacuationSite.name}`);
                agent.isRerouting = false;
                agent.currentStep = 0;
                agent.distanceToNextStep = 0;
                agent.lastStepTime = performance.now();
            } else {
                console.log(`Agent ${agent.id} failed to find alternative route`);
                // If no route can be found, stop moving
                agent.isMoving = false;
                agent.isBlocked = true;
                
                // Show warning icon
                const warningEl = document.getElementById(`warning-${agent.id}`);
                if (warningEl) warningEl.style.display = 'block';
            }
        });
        
        return; // Skip this animation frame while rerouting
    }
    
    if (!agent.lastStepTime) {
        agent.lastStepTime = timestamp;
    }
    
    // Calculate elapsed time since last step
    const elapsed = timestamp - agent.lastStepTime;
    
    // If we are at the start of a segment, calculate distance to next step
    if (agent.distanceToNextStep === 0 && agent.currentStep < agent.routePoints.length - 1) {
        const currentPoint = agent.routePoints[agent.currentStep];
        const nextPoint = agent.routePoints[agent.currentStep + 1];
        agent.distanceToNextStep = Math.sqrt(
            Math.pow(nextPoint[0] - currentPoint[0], 2) + 
            Math.pow(nextPoint[1] - currentPoint[1], 2)
        );
    }
    
    // Calculate how far along the current segment the agent should move based on consistent speed
    const stepProgress = consistentAnimationSpeed * elapsed;
    
    // Check if we've reached the next point
    if (stepProgress >= agent.distanceToNextStep || agent.currentStep >= agent.routePoints.length - 1) {
        // Move to next step or finish if at end of route
        agent.currentStep++;
        agent.distanceToNextStep = 0;
        agent.lastStepTime = timestamp;
        
        if (agent.currentStep >= agent.routePoints.length - 1) {
            // Reached destination
            agent.isMoving = false;
            agent.arrivalTime = Date.now(); // Record arrival time

            // Increment arrival counter
            arrivedCount++;
            updateArrivedCounter(arrivedCount);
            
            // Increment occupancy for the evacuation site
            if (agent.evacuationSite) {
                agent.evacuationSite.occupancy++;
                updateEvacuationCenterStatus(agent.evacuationSite);
            }
            
            // Update the point visualization
            map.getSource(`point-${agent.id}`).setData({
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Point',
                    coordinates: agent.routePoints[agent.routePoints.length - 1]
                }
            });
            
            // Move marker to destination
            agent.marker.setLngLat(agent.routePoints[agent.routePoints.length - 1]);
            
            // Check if all agents have reached their destinations
            checkAllAgentsFinished();
            return;
        }
    } else {
        // Linearly interpolate between the current point and the next point
        const currentPoint = agent.routePoints[agent.currentStep];
        const nextPoint = agent.routePoints[agent.currentStep + 1];
        const interpolationFactor = stepProgress / agent.distanceToNextStep;
        
        const interpolatedPosition = [
            currentPoint[0] + (nextPoint[0] - currentPoint[0]) * interpolationFactor,
            currentPoint[1] + (nextPoint[1] - currentPoint[1]) * interpolationFactor
        ];
        
        // Update the point visualization
        map.getSource(`point-${agent.id}`).setData({
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Point',
                coordinates: interpolatedPosition
            }
        });
        
        // Move marker to interpolated position
        agent.marker.setLngLat(interpolatedPosition);
    }
    
    // Continue animation
    agent.animationId = requestAnimationFrame((timestamp) => {
        animateAgentAlongRoute(agent, timestamp);
    });
}

// Function to reroute an agent to a different evacuation site
async function rerouteAgent(agent) {
    // Get the current position of the agent
    const currentPosition = agent.marker.getLngLat().toArray();
    
    // Get sorted list of nearest evacuation sites (excluding the current full site)
    const sortedSiteIndices = findNearestEvacuationSite(currentPosition).filter(
        index => evacuationSites[index] !== agent.evacuationSite
    );
    
    // Try each evacuation site in order of proximity until we find one without road blocks
    for (const siteIndex of sortedSiteIndices) {
        const site = evacuationSites[siteIndex];
        
        // Skip if the site is already at capacity
        if (site.isFull) {
            continue;
        }
        
        try {
            // First attempt: Try to get a direct route to the evacuation site
            let routeFound = await tryDirectRoute(agent, site, currentPosition);
            
            // Second attempt if direct route fails: Find nearest road to evacuation site
            if (!routeFound) {
                routeFound = await tryWalkingRoute(agent, site, currentPosition);
            }
            
            if (routeFound) {
                return true;
            }
        } catch (error) {
            console.error(`Error rerouting agent ${agent.id}:`, error);
        }
    }
    
    return false;
}

function startSimulation() {
    if (simulationStarted) return;
    simulationStarted = true;
    agentsStarted = false; // Reset agent start flag
    
    // Start the timer
    simulationStartTime = Date.now();
    startTimer();
    
    // Start the weather updates
    startWeatherUpdates();
    
    // Calculate routes for all agents but don't start movement yet
    const promises = agents.map(agent => getRouteForAgent(agent));
    
    Promise.all(promises).then(() => {
        // Agents will start moving when the table turns red (in updateWeatherTable)
        
        // Show message for blocked agents
        const blockedAgents = agents.filter(agent => agent.isBlocked).length;
        if (blockedAgents > 0) {
            showCustomAlert(`Warning: ${blockedAgents} citizen(s) cannot reach any evacuation center without crossing road closures. They are marked with ❗ and will not move.`);
        }
    });
}

function resetSimulation() {
    // Reset arrived counter
    arrivedCount = 0;
    updateArrivedCounter(0);

    // Clear the arrival table
    const arrivalTableBody = document.getElementById('arrivalTableBody');
    if (arrivalTableBody) {
        arrivalTableBody.innerHTML = '';
    }
    
    // Reset table footer
    const tableFooter = document.getElementById('tableFooter');
    if (tableFooter) {
        tableFooter.innerHTML = `
            <tr>
                <td colspan="2" style="text-align:right"><strong>Average Time: 0.00s</strong></td>
                <td colspan="2" style="text-align:right"><strong>Average Distance: 0.00 km</strong></td>
            </tr>
        `;
    }
    
    // Reset weather table to first row
    currentWeatherIndex = 0;
    updateWeatherTable(currentWeatherIndex);
    
    // Clear weather update interval
    if (weatherUpdateInterval) {
        clearInterval(weatherUpdateInterval);
        weatherUpdateInterval = null;
    }

    // Stop all animations
    agents.forEach(agent => {
        if (agent.animationId) {
            cancelAnimationFrame(agent.animationId);
        }
        agent.isMoving = false;
        
        // Clear route visualization
        if (map.getSource(`route-${agent.id}`)) {
            map.getSource(`route-${agent.id}`).setData({
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: []
                }
            });
        }
        
        // Clear point visualization
        if (map.getSource(`point-${agent.id}`)) {
            map.getSource(`point-${agent.id}`).setData({
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Point',
                    coordinates: [0, 0]
                }
            });
        }
        
        // Remove marker from map
        if (agent.marker) agent.marker.remove();
    });
    
    // Remove all road closure layers and sources
    roadClosures.forEach(road => {
        if (map.getLayer(road.name)) {
            map.removeLayer(road.name);
        }
        if (map.getSource(road.name)) {
            map.removeSource(road.name);
        }
    });
    
    // Remove all evacuation center markers
    evacuationSites.forEach(site => {
        if (site.marker) {
            site.marker.remove();
            site.marker = null;
        }
        site.occupancy = 0;
        site.isFull = false;
    });
    evacuationCentersVisible = false;
    
    // Remove any popups
    const popups = document.getElementsByClassName('mapboxgl-popup');
    while (popups[0]) {
        popups[0].remove();
    }
    
    // Clear agents array
    agents = [];
    
    // Generate new agents using the JSON data
    generateAgents(MAX_AGENTS);
    
    // Reset timer
    stopTimer();
    document.getElementById('timer-box').textContent = 'Simulation Time: 0:00';
    document.getElementById('timer').textContent = 'Time: 0:00';
    
    simulationStarted = false;
    agentsStarted = false; // Reset agent start flag
}

function startTimer() {
    // Clear any existing interval
    if (timerInterval) {
        clearInterval(timerInterval);
    }
    
    // Start a new interval
    timerInterval = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - simulationStartTime) / 1000);
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        
        // Update both timer displays
        document.getElementById('timer-box').textContent = `Simulation Time: ${minutes}:${seconds.toString().padStart(2, '0')}`;
        document.getElementById('timer').textContent = `Time: ${minutes}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateArrivedCounter(count) {
    // Update both arrived counter displays
    const arrivedCounter = document.getElementById('arrived-counter');
    if (arrivedCounter) {
        arrivedCounter.textContent = `Arrived: ${count}`;
    }
    
    const arrivedBox = document.getElementById('arrived-box');
    if (arrivedBox) {
        arrivedBox.textContent = `Arrived: ${count}`;
    }
}

function checkAllAgentsFinished() {
    // Count total agents that can move (not blocked)
    const movableAgents = agents.filter(agent => !agent.isBlocked).length;
    
    // Count agents that have finished moving
    const finishedAgents = agents.filter(agent => !agent.isBlocked && !agent.isMoving).length;

    // Update arrived counter
    arrivedCount = finishedAgents;
    updateArrivedCounter(arrivedCount);
    
    // If all movable agents have finished, stop the timer and show completion message
    if (finishedAgents === movableAgents && finishedAgents > 0) {
        stopTimer();
        
        // Calculate elapsed time
        const elapsedMilliseconds = Date.now() - simulationStartTime;
        const elapsedSeconds = Math.floor(elapsedMilliseconds / 1000);
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        
        // Get blocked agent count
        const blockedAgents = agents.filter(agent => agent.isBlocked).length;
        
        // Update arrival data for each agent that reached destination
        agents.filter(agent => !agent.isBlocked && !agent.isMoving).forEach(agent => {
            // Calculate time taken for this agent
            // Calculate time taken for this agent in milliseconds, but store as seconds with decimals
            const timeTakenMilliseconds = agent.arrivalTime - simulationStartTime;
            agent.timeTaken = timeTakenMilliseconds / 1000; // Store in seconds with decimals
        
            // Calculate distance traveled (approximate from route points)
            let totalDistance = 0;
            for (let i = 0; i < agent.routePoints.length - 1; i++) {
                const point1 = turf.point(agent.routePoints[i]);
                const point2 = turf.point(agent.routePoints[i + 1]);
                totalDistance += turf.distance(point1, point2);
            }
            agent.distance = totalDistance;
        
            // Add to the arrival table
            if (window.updateAgentArrivalData) {
                window.updateAgentArrivalData(agent);
            }
        });

        // Calculate and display statistics
        calculateAndDisplayStats();
    }
}

function calculateAndDisplayStats() {
    const finishedAgents = agents.filter(agent => !agent.isBlocked && !agent.isMoving);
    
    if (finishedAgents.length === 0) return;
    
    // Calculate total distance and average time
    let totalDistance = 0;
    let totalTime = 0;
    
    finishedAgents.forEach(agent => {
        totalDistance += agent.distance || 0;
        totalTime += agent.timeTaken || 0;
    });
    
    const averageTime = totalTime / finishedAgents.length;
    const averageDistance = totalDistance / finishedAgents.length;
    
    // Update the table footer with averages
    const tableFooter = document.getElementById('tableFooter');
    if (tableFooter) {
        tableFooter.innerHTML = `
            <tr>
                <td colspan="2" style="text-align:right"><strong>Average Time: ${averageTime.toFixed(2)}s</strong></td>
                <td colspan="2" style="text-align:right"><strong>Average Distance: ${averageDistance.toFixed(2)} km</strong></td>
            </tr>
        `;
    }
}

function showCustomAlert(message) {
    const modal = document.getElementById("myModal");
    const alertMessage = document.getElementById("alertMessage");
    alertMessage.innerHTML = message;
    modal.style.display = "block";
}

// Event listeners
document.getElementById('startSimulation').addEventListener('click', startSimulation);
document.getElementById('resetSimulation').addEventListener('click', resetSimulation);

// Close the modal when the user clicks the close button
const closeBtn = document.getElementsByClassName("close")[0];
closeBtn.onclick = function() {
    document.getElementById("myModal").style.display = "none";
}

// Close the modal if the user clicks anywhere outside of it
window.onclick = function(event) {
    const modal = document.getElementById("myModal");
    if (event.target == modal) {
        modal.style.display = "none";
    }
}   
}

window.initMap = initMap;