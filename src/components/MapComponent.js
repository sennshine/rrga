import React, { useEffect, useState } from "react";
import mapboxgl from "mapbox-gl";
import Papa from "papaparse";

mapboxgl.accessToken = "pk.eyJ1Ijoid3NuYzAiLCJhIjoiY204eDR2eXM1MDBoeDJrb3RxcWcycGh0MSJ9.RrkeTWJCa3lhoQJsTq_EBQ";

const MapComponent = () => {
    const [map, setMap] = useState(null);
    const [evacCenters, setEvacCenters] = useState([]);
    const [roadClosures, setRoadClosures] = useState([]);

    // User's starting position
    const origin = [115.542913, 5.298978]; // Example starting location

    useEffect(() => {
        // Initialize Mapbox map
        const newMap = new mapboxgl.Map({
            container: "map",
            style: "mapbox://styles/mapbox/streets-v11",
            center: origin,
            zoom: 9,
        });

        setMap(newMap);

        newMap.on("load", () => {
            addUserMarker(newMap);
            loadEvacuationCenters(newMap);
            loadRoadClosures(newMap);
        });

        return () => newMap.remove();
    }, []);

    // Add User's Starting Marker
    const addUserMarker = (map) => {
        new mapboxgl.Marker({ color: "blue" })
            .setLngLat(origin)
            .setPopup(new mapboxgl.Popup().setHTML("<strong>Start Location</strong>"))
            .addTo(map);
    };

    // Load Evacuation Centers from CSV
    const loadEvacuationCenters = async (map) => {
        const response = await fetch("/Evac_Centres.csv");
        const text = await response.text();

        Papa.parse(text, {
            header: true,
            skipEmptyLines: true,
            complete: (result) => {
                setEvacCenters(result.data);
                result.data.forEach((center) => {
                    addEvacuationMarker(map, center);
                });
            },
        });
    };

    // Add Evacuation Centers as Green Markers
    const addEvacuationMarker = (map, center) => {
        new mapboxgl.Marker({ color: "green" })
            .setLngLat([parseFloat(center.Longitude), parseFloat(center.Latitude)])
            .setPopup(new mapboxgl.Popup().setHTML(`<strong>${center["Relief Centre"]}</strong>`))
            .addTo(map);
    };

    // Load Road Closures from CSV
    const loadRoadClosures = async (map) => {
        const response = await fetch("/Road_Closure_Sabah.csv");
        const text = await response.text();

        Papa.parse(text, {
            header: true,
            skipEmptyLines: true,
            complete: (result) => {
                setRoadClosures(result.data);
                drawRoadClosures(map, result.data);
            },
        });
    };

    // Draw Road Closures as Purple Lines
    const drawRoadClosures = (map, closures) => {
        closures.forEach((road, index) => {
            const roadGeoJson = {
                type: "Feature",
                properties: { name: road["Name Of Road"] },
                geometry: {
                    type: "LineString",
                    coordinates: [
                        [parseFloat(road.start_longitude), parseFloat(road.start_latitude)],
                        [parseFloat(road.end_longitude), parseFloat(road.end_latitude)],
                    ],
                },
            };

            map.addSource(`road-closure-${index}`, { type: "geojson", data: roadGeoJson });

            map.addLayer({
                id: `road-closure-${index}`,
                type: "line",
                source: `road-closure-${index}`,
                layout: { "line-join": "round", "line-cap": "round" },
                paint: { "line-color": "#800080", "line-width": 4 },
            });
        });
    };

    return <div id="map" style={{ width: "100%", height: "90vh" }}></div>;
};

export default MapComponent;
