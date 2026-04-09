/**
 * Timezone Helper Module
 * Provides utilities for generating and managing timezone selectors
 */

// Full list of 60+ timezones
const TIMEZONES = [
    { value: 'UTC', label: 'UTC (Coordinated Universal Time)', offset: 0 },
    { value: 'Europe/London', label: 'London (UTC+0/+1)', offset: 0 },
    { value: 'Europe/Dublin', label: 'Dublin (UTC+0/+1)', offset: 0 },
    { value: 'Europe/Lisbon', label: 'Lisbon (UTC+0/+1)', offset: 0 },
    { value: 'Atlantic/Reykjavik', label: 'Reykjavik (UTC+0)', offset: 0 },
    { value: 'Africa/Casablanca', label: 'Casablanca (UTC+0/+1)', offset: 1 },
    { value: 'Europe/Paris', label: 'Paris (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Berlin', label: 'Berlin (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Rome', label: 'Rome (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Madrid', label: 'Madrid (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Amsterdam', label: 'Amsterdam (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Brussels', label: 'Brussels (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Vienna', label: 'Vienna (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Stockholm', label: 'Stockholm (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Oslo', label: 'Oslo (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Copenhagen', label: 'Copenhagen (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Warsaw', label: 'Warsaw (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Prague', label: 'Prague (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Budapest', label: 'Budapest (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Zurich', label: 'Zurich (UTC+1/+2)', offset: 1 },
    { value: 'Europe/Moscow', label: 'Moscow (UTC+3)', offset: 3 },
    { value: 'Europe/Kiev', label: 'Kiev (UTC+2/+3)', offset: 2 },
    { value: 'Europe/Minsk', label: 'Minsk (UTC+3)', offset: 3 },
    { value: 'Europe/Istanbul', label: 'Istanbul (UTC+3)', offset: 3 },
    { value: 'Europe/Athens', label: 'Athens (UTC+2/+3)', offset: 2 },
    { value: 'Europe/Bucharest', label: 'Bucharest (UTC+2/+3)', offset: 2 },
    { value: 'Europe/Helsinki', label: 'Helsinki (UTC+2/+3)', offset: 2 },
    { value: 'Europe/Riga', label: 'Riga (UTC+2/+3)', offset: 2 },
    { value: 'Europe/Vilnius', label: 'Vilnius (UTC+2/+3)', offset: 2 },
    { value: 'Europe/Tallinn', label: 'Tallinn (UTC+2/+3)', offset: 2 },
    { value: 'Asia/Dubai', label: 'Dubai (UTC+4)', offset: 4 },
    { value: 'Asia/Baku', label: 'Baku (UTC+4)', offset: 4 },
    { value: 'Asia/Yerevan', label: 'Yerevan (UTC+4)', offset: 4 },
    { value: 'Asia/Tbilisi', label: 'Tbilisi (UTC+4)', offset: 4 },
    { value: 'Asia/Tehran', label: 'Tehran (UTC+3:30/+4:30)', offset: 3.5 },
    { value: 'Asia/Kabul', label: 'Kabul (UTC+4:30)', offset: 4.5 },
    { value: 'Asia/Karachi', label: 'Karachi (UTC+5)', offset: 5 },
    { value: 'Asia/Tashkent', label: 'Tashkent (UTC+5)', offset: 5 },
    { value: 'Asia/Yekaterinburg', label: 'Yekaterinburg (UTC+5)', offset: 5 },
    { value: 'Asia/Kolkata', label: 'Kolkata (UTC+5:30)', offset: 5.5 },
    { value: 'Asia/Colombo', label: 'Colombo (UTC+5:30)', offset: 5.5 },
    { value: 'Asia/Kathmandu', label: 'Kathmandu (UTC+5:45)', offset: 5.75 },
    { value: 'Asia/Almaty', label: 'Almaty (UTC+6)', offset: 6 },
    { value: 'Asia/Dhaka', label: 'Dhaka (UTC+6)', offset: 6 },
    { value: 'Asia/Omsk', label: 'Omsk (UTC+6)', offset: 6 },
    { value: 'Asia/Yangon', label: 'Yangon (UTC+6:30)', offset: 6.5 },
    { value: 'Asia/Bangkok', label: 'Bangkok (UTC+7)', offset: 7 },
    { value: 'Asia/Ho_Chi_Minh', label: 'Ho Chi Minh (UTC+7)', offset: 7 },
    { value: 'Asia/Jakarta', label: 'Jakarta (UTC+7)', offset: 7 },
    { value: 'Asia/Krasnoyarsk', label: 'Krasnoyarsk (UTC+7)', offset: 7 },
    { value: 'Asia/Shanghai', label: 'Shanghai (UTC+8)', offset: 8 },
    { value: 'Asia/Hong_Kong', label: 'Hong Kong (UTC+8)', offset: 8 },
    { value: 'Asia/Singapore', label: 'Singapore (UTC+8)', offset: 8 },
    { value: 'Asia/Taipei', label: 'Taipei (UTC+8)', offset: 8 },
    { value: 'Asia/Kuala_Lumpur', label: 'Kuala Lumpur (UTC+8)', offset: 8 },
    { value: 'Asia/Manila', label: 'Manila (UTC+8)', offset: 8 },
    { value: 'Asia/Irkutsk', label: 'Irkutsk (UTC+8)', offset: 8 },
    { value: 'Australia/Perth', label: 'Perth (UTC+8)', offset: 8 },
    { value: 'Asia/Tokyo', label: 'Tokyo (UTC+9)', offset: 9 },
    { value: 'Asia/Seoul', label: 'Seoul (UTC+9)', offset: 9 },
    { value: 'Asia/Pyongyang', label: 'Pyongyang (UTC+9)', offset: 9 },
    { value: 'Asia/Yakutsk', label: 'Yakutsk (UTC+9)', offset: 9 },
    { value: 'Australia/Darwin', label: 'Darwin (UTC+9:30)', offset: 9.5 },
    { value: 'Australia/Adelaide', label: 'Adelaide (UTC+9:30/+10:30)', offset: 9.5 },
    { value: 'Asia/Vladivostok', label: 'Vladivostok (UTC+10)', offset: 10 },
    { value: 'Australia/Sydney', label: 'Sydney (UTC+10/+11)', offset: 10 },
    { value: 'Australia/Melbourne', label: 'Melbourne (UTC+10/+11)', offset: 10 },
    { value: 'Australia/Brisbane', label: 'Brisbane (UTC+10)', offset: 10 },
    { value: 'Pacific/Guam', label: 'Guam (UTC+10)', offset: 10 },
    { value: 'Pacific/Noumea', label: 'Noumea (UTC+11)', offset: 11 },
    { value: 'Asia/Magadan', label: 'Magadan (UTC+11)', offset: 11 },
    { value: 'Pacific/Auckland', label: 'Auckland (UTC+12/+13)', offset: 12 },
    { value: 'Pacific/Fiji', label: 'Fiji (UTC+12/+13)', offset: 12 },
    { value: 'Pacific/Tarawa', label: 'Tarawa (UTC+12)', offset: 12 },
    { value: 'Pacific/Chatham', label: 'Chatham (UTC+12:45/+13:45)', offset: 12.75 },
    { value: 'Pacific/Tongatapu', label: 'Tongatapu (UTC+13)', offset: 13 },
    { value: 'Pacific/Apia', label: 'Apia (UTC+13/+14)', offset: 13 },
    { value: 'Pacific/Kiritimati', label: 'Kiritimati (UTC+14)', offset: 14 },
    { value: 'America/New_York', label: 'New York (UTC-5/-4)', offset: -5 },
    { value: 'America/Toronto', label: 'Toronto (UTC-5/-4)', offset: -5 },
    { value: 'America/Montreal', label: 'Montreal (UTC-5/-4)', offset: -5 },
    { value: 'America/Boston', label: 'Boston (UTC-5/-4)', offset: -5 },
    { value: 'America/Miami', label: 'Miami (UTC-5/-4)', offset: -5 },
    { value: 'America/Chicago', label: 'Chicago (UTC-6/-5)', offset: -6 },
    { value: 'America/Mexico_City', label: 'Mexico City (UTC-6/-5)', offset: -6 },
    { value: 'America/Denver', label: 'Denver (UTC-7/-6)', offset: -7 },
    { value: 'America/Phoenix', label: 'Phoenix (UTC-7)', offset: -7 },
    { value: 'America/Los_Angeles', label: 'Los Angeles (UTC-8/-7)', offset: -8 },
    { value: 'America/Vancouver', label: 'Vancouver (UTC-8/-7)', offset: -8 },
    { value: 'America/Anchorage', label: 'Anchorage (UTC-9/-8)', offset: -9 },
    { value: 'Pacific/Honolulu', label: 'Honolulu (UTC-10)', offset: -10 },
    { value: 'Pacific/Midway', label: 'Midway (UTC-11)', offset: -11 },
    { value: 'America/Sao_Paulo', label: 'Sao Paulo (UTC-3/-2)', offset: -3 },
    { value: 'America/Buenos_Aires', label: 'Buenos Aires (UTC-3)', offset: -3 },
    { value: 'America/Santiago', label: 'Santiago (UTC-4/-3)', offset: -4 },
    { value: 'America/Bogota', label: 'Bogota (UTC-5)', offset: -5 },
    { value: 'America/Lima', label: 'Lima (UTC-5)', offset: -5 },
    { value: 'America/Caracas', label: 'Caracas (UTC-4)', offset: -4 }
];

/**
 * Generate a timezone select element with full list of options
 * @param {string} elementId - ID of the select element to populate
 * @param {string} selectedValue - Currently selected timezone value
 * @returns {HTMLElement} The populated select element
 */
function generateTimezoneSelect(elementId, selectedValue = 'Europe/Moscow') {
    const select = document.getElementById(elementId);
    if (!select) {
        console.error(`[TimezoneHelper] Element ${elementId} not found`);
        return null;
    }

    // Clear existing options
    select.innerHTML = '';

    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '-- Выберите часовой пояс --';
    select.appendChild(defaultOption);

    // Add timezone options sorted by offset
    const sortedTz = [...TIMEZONES].sort((a, b) => a.offset - b.offset);
    
    sortedTz.forEach(tz => {
        const option = document.createElement('option');
        option.value = tz.value;
        option.textContent = tz.label;
        if (tz.value === selectedValue) {
            option.selected = true;
        }
        select.appendChild(option);
    });

    return select;
}

/**
 * Get selected weekdays for a channel
 * @param {string} channelPrefix - Channel prefix (e.g., 'telegram', 'pinterest')
 * @returns {number[]} Array of selected weekday values (0-6)
 */
function getWeekdays(channelPrefix) {
    const selector = `.${channelPrefix}-weekday`;
    const checkboxes = document.querySelectorAll(selector);
    const weekdays = [];
    
    checkboxes.forEach(cb => {
        if (cb.checked) {
            weekdays.push(parseInt(cb.value, 10));
        }
    });
    
    return weekdays.sort((a, b) => a - b);
}

/**
 * Set selected weekdays for a channel
 * @param {string} channelPrefix - Channel prefix (e.g., 'telegram', 'pinterest')
 * @param {number[]} weekdaysArray - Array of weekday values to select (0-6)
 */
function setWeekdays(channelPrefix, weekdaysArray) {
    const selector = `.${channelPrefix}-weekday`;
    const checkboxes = document.querySelectorAll(selector);
    
    checkboxes.forEach(cb => {
        const value = parseInt(cb.value, 10);
        cb.checked = weekdaysArray.includes(value);
    });
}

/**
 * Generate weekday checkboxes HTML
 * @param {string} channelPrefix - Channel prefix for class names
 * @param {number[]} selectedWeekdays - Currently selected weekdays
 * @returns {string} HTML string for weekday checkboxes
 */
function generateWeekdayCheckboxes(channelPrefix, selectedWeekdays = []) {
    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    
    return dayNames.map((dayName, index) => {
        const checked = selectedWeekdays.includes(index) ? 'checked' : '';
        return `<label class="weekday-label">
            <input type="checkbox" class="${channelPrefix}-weekday" value="${index}" ${checked}>
            <span>${dayName}</span>
        </label>`;
    }).join('\n');
}

/**
 * Format time value to HH:MM string
 * @param {string} hour - Hour value
 * @param {string} minute - Minute value
 * @returns {string} Formatted time string
 */
function formatTime(hour, minute) {
    const h = hour.toString().padStart(2, '0');
    const m = minute.toString().padStart(2, '0');
    return `${h}:${m}`;
}

/**
 * Parse time string to hour and minute
 * @param {string} timeString - Time string in HH:MM format
 * @returns {{hour: string, minute: string}}
 */
function parseTime(timeString) {
    if (!timeString) return { hour: '09', minute: '00' };
    
    const [hour, minute] = timeString.split(':');
    return {
        hour: hour || '09',
        minute: minute || '00'
    };
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TIMEZONES,
        generateTimezoneSelect,
        getWeekdays,
        setWeekdays,
        generateWeekdayCheckboxes,
        formatTime,
        parseTime
    };
}
