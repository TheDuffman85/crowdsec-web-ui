import { useMemo } from 'react';
import {
    ComposableMap,
    Geographies,
    Geography,
    ZoomableGroup
} from 'react-simple-maps';
import { scaleLinear } from 'd3-scale';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Globe } from 'lucide-react';

const geoUrl = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

// Color scale for choropleth
const getColorScale = (maxCount) => {
    return scaleLinear()
        .domain([0, maxCount / 2, maxCount])
        .range(['#f0f0f0', '#FFB7B2', '#FF5252'])
        .clamp(true);
};

/**
 * Country Map Card with World Map and Top 10 List
 */
export function CountryMapCard({ data, onCountrySelect, selectedCountry }) {
    // Calculate total for percentages
    const totalCount = useMemo(() => {
        return data.reduce((sum, item) => sum + item.count, 0);
    }, [data]);

    // Create a map of country code to count for quick lookup
    const countryDataMap = useMemo(() => {
        const map = {};
        data.forEach(item => {
            if (item.countryCode) {
                map[item.countryCode.toUpperCase()] = item.count;
            }
        });
        return map;
    }, [data]);

    // Get max count for color scaling
    const maxCount = useMemo(() => {
        return Math.max(...data.map(d => d.count), 1);
    }, [data]);

    const colorScale = getColorScale(maxCount);

    // Get top 10 for the list
    const top10Countries = useMemo(() => data.slice(0, 10), [data]);

    return (
        <Card className="h-full">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Globe className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    Top Countries
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="flex flex-col lg:flex-row gap-6">
                    {/* World Map - Left Side */}
                    <div className="flex-1 min-w-[400px] flex items-start">
                        {data.length === 0 ? (
                            <div className="w-full min-h-[400px] flex items-center justify-center text-gray-500">
                                No country data available
                            </div>
                        ) : (
                            <ComposableMap
                                projectionConfig={{
                                    scale: 147
                                }}
                                className="w-full h-auto"
                                style={{ maxHeight: '500px' }}
                            >
                                <ZoomableGroup center={[0, 20]} zoom={1}>
                                    <Geographies geography={geoUrl}>
                                        {({ geographies }) =>
                                            geographies.map((geo) => {
                                                const countryCode = geo.id; // ISO 3-digit code
                                                const alpha2Code = geo.properties?.ISO_A2; // ISO 2-letter code
                                                const count = countryDataMap[alpha2Code] || 0;
                                                const isSelected = selectedCountry === alpha2Code;

                                                return (
                                                    <Geography
                                                        key={geo.rsmKey}
                                                        geography={geo}
                                                        fill={count > 0 ? colorScale(count) : '#E5E7EB'}
                                                        stroke={isSelected ? '#2563eb' : '#fff'}
                                                        strokeWidth={isSelected ? 2 : 0.5}
                                                        style={{
                                                            default: {
                                                                outline: 'none',
                                                                opacity: isSelected ? 1 : (selectedCountry ? 0.3 : 1)
                                                            },
                                                            hover: {
                                                                outline: 'none',
                                                                fill: count > 0 ? '#FF5252' : '#D1D5DB',
                                                                cursor: count > 0 ? 'pointer' : 'default',
                                                                opacity: 1,
                                                                stroke: '#2563eb',
                                                                strokeWidth: 2
                                                            },
                                                            pressed: {
                                                                outline: 'none'
                                                            }
                                                        }}
                                                        onClick={() => {
                                                            if (count > 0 && alpha2Code) {
                                                                onCountrySelect(alpha2Code);
                                                            }
                                                        }}
                                                    >
                                                        <title>
                                                            {geo.properties?.name || 'Unknown'}: {count > 0 ? count.toLocaleString() : '0'} alerts
                                                        </title>
                                                    </Geography>
                                                );
                                            })
                                        }
                                    </Geographies>
                                </ZoomableGroup>
                            </ComposableMap>
                        )}
                    </div>

                    {/* Top 10 List - Right Side */}
                    <div className="lg:w-80 flex flex-col">
                        <div className="space-y-2 flex-1 overflow-y-auto">
                            {top10Countries.length === 0 ? (
                                <div className="text-center text-gray-500 py-4">No data available</div>
                            ) : (
                                top10Countries.map((item, index) => {
                                    const isSelected = selectedCountry === item.countryCode;
                                    const percent = totalCount > 0 ? (item.count / totalCount * 100).toFixed(1) : '0.0';

                                    return (
                                        <div
                                            key={item.countryCode || index}
                                            onClick={() => onCountrySelect(item.countryCode)}
                                            className={`flex items-center justify-between p-3 rounded-lg cursor-pointer transition-all ${isSelected
                                                    ? 'bg-primary-100 dark:bg-primary-900/30 ring-2 ring-primary-500'
                                                    : 'bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700'
                                                }`}
                                        >
                                            <div className="flex items-center gap-3 flex-1 min-w-0">
                                                <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 w-5 flex-shrink-0">
                                                    #{index + 1}
                                                </span>
                                                {item.countryCode && (
                                                    <span
                                                        className={`fi fi-${item.countryCode.toLowerCase()} flex-shrink-0`}
                                                        style={{
                                                            width: '1.5em',
                                                            height: '1.5em',
                                                            borderRadius: '2px',
                                                            boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                                                        }}
                                                    />
                                                )}
                                                <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                                                    {item.label}
                                                </span>
                                            </div>
                                            <div className="flex flex-col items-end ml-3 flex-shrink-0">
                                                <span className="text-sm font-bold text-gray-900 dark:text-white">
                                                    {item.count.toLocaleString()}
                                                </span>
                                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                                    {percent}%
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
