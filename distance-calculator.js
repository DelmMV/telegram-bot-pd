const axios = require("axios");
const config = require("./config");

/**
 * Модуль для расчета расстояний по дорогам и тарификации
 */

// Кэш для расстояний (чтобы не делать повторные запросы)
const distanceCache = new Map();

// Кэш для геокодирования адресов
const geocodeCache = new Map();

/**
 * Геокодирует адрес и возвращает координаты
 * @param {string} address - Адрес для геокодирования
 * @returns {Promise<Object|null>} { lat, lon } или null
 */
async function geocodeAddress(address) {
  if (!address) return null;

  try {
    // Проверяем кэш
    if (geocodeCache.has(address)) {
      return geocodeCache.get(address);
    }

    // Используем Nominatim (OpenStreetMap) для геокодирования
    const response = await axios.get(
      "https://nominatim.openstreetmap.org/search",
      {
        params: {
          q: address,
          format: "json",
          limit: 1,
          addressdetails: 1,
        },
        headers: {
          "User-Agent": "TelegramDeliveryBot/1.0",
        },
        timeout: 5000,
      },
    );

    if (response.data && response.data.length > 0) {
      const result = {
        lat: parseFloat(response.data[0].lat),
        lon: parseFloat(response.data[0].lon),
      };

      // Сохраняем в кэш
      geocodeCache.set(address, result);

      // Небольшая задержка для соблюдения rate limit Nominatim (1 запрос/сек)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      return result;
    }

    return null;
  } catch (error) {
    console.error(`Geocoding error for "${address}":`, error.message);
    return null;
  }
}

/**
 * Извлекает координаты из точки маршрута
 * @param {Object} point - Точка маршрута с координатами
 * @returns {Promise<Object|null>} { lat, lon } или null
 */
async function extractCoordinates(point) {
  try {
    // Приоритет 1: Координаты из Address.Location (API VRP Logdep)
    if (point.Address?.Location?.Lat && point.Address?.Location?.Lon) {
      return {
        lat: parseFloat(point.Address.Location.Lat),
        lon: parseFloat(point.Address.Location.Lon),
      };
    }

    // Приоритет 2: Координаты напрямую из точки (Points маршрута)
    if (point.Lat && point.Lon) {
      return {
        lat: parseFloat(point.Lat),
        lon: parseFloat(point.Lon),
      };
    }

    if (point.Latitude && point.Longitude) {
      return {
        lat: parseFloat(point.Latitude),
        lon: parseFloat(point.Longitude),
      };
    }

    if (point.lat && point.lon) {
      return {
        lat: parseFloat(point.lat),
        lon: parseFloat(point.lon),
      };
    }

    if (point.latitude && point.longitude) {
      return {
        lat: parseFloat(point.latitude),
        lon: parseFloat(point.longitude),
      };
    }

    // Если координат нет, пробуем геокодировать адрес (последний вариант)
    if (point.Address) {
      // Если Address - строка, геокодируем её
      const addressString =
        typeof point.Address === "string"
          ? point.Address
          : point.Address.Raw || point.Address.OriginalRaw;

      if (addressString) {
        const geocoded = await geocodeAddress(addressString);
        if (geocoded) {
          return geocoded;
        }
      }
    }

    // Если ничего не помогло, возвращаем null
    return null;
  } catch (error) {
    console.error("Error extracting coordinates:", error);
    return null;
  }
}

/**
 * Создает уникальный ключ для кэша
 * @param {Object} from - Начальная точка
 * @param {Object} to - Конечная точка
 * @returns {string}
 */
function getCacheKey(from, to) {
  return `${from.lat.toFixed(6)},${from.lon.toFixed(6)}->${to.lat.toFixed(6)},${to.lon.toFixed(6)}`;
}

/**
 * Рассчитывает расстояние по дорогам между двумя точками
 * Использует OSRM API (Open Source Routing Machine)
 * @param {Object} fromCoords - { lat, lon } начальной точки
 * @param {Object} toCoords - { lat, lon } конечной точки
 * @returns {Promise<number>} Расстояние в километрах
 */
async function calculateRoadDistance(fromCoords, toCoords) {
  try {
    // Проверяем кэш
    const cacheKey = getCacheKey(fromCoords, toCoords);
    if (distanceCache.has(cacheKey)) {
      const cachedDistance = distanceCache.get(cacheKey);
      console.log(
        `    → Using cached distance: ${cachedDistance.toFixed(2)} km`,
      );
      return cachedDistance;
    }

    // Формируем URL для OSRM API
    // Формат: /route/v1/driving/{lon1},{lat1};{lon2},{lat2}
    const url = `${config.ROUTING_API.url}/${fromCoords.lon},${fromCoords.lat};${toCoords.lon},${toCoords.lat}`;

    console.log(`    → OSRM request: ${url}`);

    const response = await axios.get(url, {
      timeout: config.ROUTING_API.timeout,
      params: {
        overview: "false", // Не нужна геометрия маршрута
        alternatives: "false", // Только один маршрут
        steps: "false", // Не нужны шаги
      },
    });

    if (
      response.data &&
      response.data.routes &&
      response.data.routes.length > 0
    ) {
      // Расстояние в метрах, конвертируем в километры
      const distanceKm = response.data.routes[0].distance / 1000;

      // Сохраняем в кэш
      distanceCache.set(cacheKey, distanceKm);

      console.log(`    ✓ OSRM distance: ${distanceKm.toFixed(2)} km`);
      return distanceKm;
    }

    // Если не удалось получить маршрут, используем прямое расстояние
    const straightDistance = calculateStraightDistance(fromCoords, toCoords);
    console.warn(
      `    ⚠ OSRM API не вернул маршрут, прямое расстояние: ${straightDistance.toFixed(2)} km`,
    );
    return straightDistance;
  } catch (error) {
    const straightDistance = calculateStraightDistance(fromCoords, toCoords);
    console.error(`    ✗ OSRM error: ${error.message}`);
    console.log(
      `    → Using straight distance: ${straightDistance.toFixed(2)} km`,
    );

    // В случае ошибки используем прямое расстояние
    return straightDistance;
  }
}

/**
 * Рассчитывает прямое расстояние между двумя точками (формула Гаверсинуса)
 * Используется как fallback если API недоступен
 * @param {Object} from - { lat, lon }
 * @param {Object} to - { lat, lon }
 * @returns {number} Расстояние в километрах
 */
function calculateStraightDistance(from, to) {
  const R = 6371; // Радиус Земли в километрах

  const dLat = toRadians(to.lat - from.lat);
  const dLon = toRadians(to.lon - from.lon);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}

/**
 * Конвертирует градусы в радианы
 * @param {number} degrees
 * @returns {number}
 */
function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Определяет стоимость доставки на основе расстояния
 * @param {number} distanceKm - Расстояние в километрах
 * @returns {number} Стоимость в рублях
 */
function calculateDeliveryPrice(distanceKm) {
  // Проходим по тарифам и находим подходящий
  for (const tariff of config.TARIFFS) {
    if (distanceKm <= tariff.maxDistance) {
      return tariff.price;
    }
  }

  // Если не нашли (не должно происходить с Infinity), возвращаем максимальный тариф
  return config.TARIFFS[config.TARIFFS.length - 1].price;
}

/**
 * Рассчитывает расстояние и стоимость для точки доставки
 * @param {Object} deliveryPoint - Точка доставки из маршрута
 * @param {Object} startPoint - Точка старта (опционально, по умолчанию из config)
 * @returns {Promise<Object>} { distance: number, price: number, coordinates: Object }
 */
async function calculatePointEarnings(deliveryPoint, startPoint = null) {
  try {
    const start = startPoint || config.START_POINT;
    const addressStr =
      typeof deliveryPoint.Address === "string"
        ? deliveryPoint.Address
        : deliveryPoint.Address?.Raw ||
          deliveryPoint.Address?.OriginalRaw ||
          "Unknown";

    console.log(`  Calculating earnings for: ${addressStr}`);

    // Извлекаем координаты точки доставки (теперь с await!)
    const deliveryCoords = await extractCoordinates(deliveryPoint);

    if (!deliveryCoords) {
      console.log(`  ✗ NO_COORDINATES for: ${addressStr}`);
      console.log(
        `    Point structure:`,
        JSON.stringify({
          hasLat: !!deliveryPoint.Lat,
          hasLon: !!deliveryPoint.Lon,
          hasAddress: !!deliveryPoint.Address,
          addressType: typeof deliveryPoint.Address,
        }),
      );
      return {
        distance: 0,
        price: 0,
        coordinates: null,
        error: "NO_COORDINATES",
      };
    }

    console.log(
      `  ✓ Coordinates found: [${deliveryCoords.lat}, ${deliveryCoords.lon}]`,
    );
    console.log(`    Start point: [${start.lat}, ${start.lon}]`);

    // Рассчитываем расстояние по дорогам
    const distance = await calculateRoadDistance(start, deliveryCoords);

    // Определяем стоимость
    const price = calculateDeliveryPrice(distance);

    console.log(`  ✓ Distance: ${distance.toFixed(2)} km, Price: ${price} rub`);

    return {
      distance: Math.round(distance * 100) / 100, // Округляем до 2 знаков
      price,
      coordinates: deliveryCoords,
    };
  } catch (error) {
    const addressStr =
      typeof deliveryPoint.Address === "string"
        ? deliveryPoint.Address
        : deliveryPoint.Address?.Raw ||
          deliveryPoint.Address?.OriginalRaw ||
          "Unknown";
    console.error(
      `  ✗ Exception in calculatePointEarnings for ${addressStr}:`,
      error.message,
    );
    console.error(`    Stack:`, error.stack);
    return {
      distance: 0,
      price: 0,
      coordinates: null,
      error: error.message,
    };
  }
}

/**
 * Рассчитывает общую статистику заработка для всех точек маршрута
 * @param {Array} points - Массив точек маршрута
 * @param {Array} orders - Массив заказов с координатами (опционально)
 * @returns {Promise<Object>} { totalDistance, totalEarnings, pointsDetails }
 */
async function calculateRouteEarnings(points, orders = null) {
  try {
    let totalDistance = 0;
    let totalEarnings = 0;
    const pointsDetails = [];

    // Извлекаем координаты точки производства (первая точка маршрута)
    let startPoint = null;
    if (points && points.length > 0) {
      startPoint = await extractCoordinates(points[0]);
    }

    // Если не удалось получить координаты производства, используем из config
    if (!startPoint) {
      startPoint = config.START_POINT;
    }

    // Пропускаем первую точку (это точка производства/склад)
    for (let i = 1; i < points.length; i++) {
      const point = points[i];

      // Если есть orders, пытаемся найти координаты из заказов
      let pointWithCoords = point;
      if (orders && point.Orders && point.Orders.length > 0) {
        // Находим первый заказ этой точки
        const orderId = point.Orders[0].Id;
        const order = orders.find((o) => o.Id === orderId);

        if (
          order &&
          order.To &&
          order.To.Address &&
          order.To.Address.Location
        ) {
          // Создаем объект с координатами из заказа
          pointWithCoords = {
            ...point,
            Address: {
              Location: {
                Lat: order.To.Address.Location.Lat,
                Lon: order.To.Address.Location.Lon,
              },
              Raw: order.To.Address.Raw || point.Address,
              OriginalRaw: order.To.Address.OriginalRaw,
            },
          };
        }
      }

      // Рассчитываем для каждой точки, передавая точку старта
      const earnings = await calculatePointEarnings(
        pointWithCoords,
        startPoint,
      );

      // Получаем количество заказов в точке
      const ordersCount = point.Orders?.length || 1;

      // Если не удалось рассчитать расстояние, используем минимальный тариф
      let price = earnings.price;
      let distance = earnings.distance;

      if (earnings.error) {
        // Используем минимальный тариф из конфигурации
        price = config.TARIFFS[0].price; // 180 руб
        distance = 0;
        console.log(
          `Cannot calculate distance for point ${i} (${point.Address}), using minimum tariff: ${price} rub`,
        );
      }

      // Заработок = базовая стоимость × количество заказов
      const pointEarnings = price * ordersCount;

      totalDistance += distance;
      totalEarnings += pointEarnings;

      pointsDetails.push({
        index: i,
        address: point.Address,
        distance: distance,
        pricePerOrder: price,
        ordersCount: ordersCount,
        totalPrice: pointEarnings,
        coordinates: earnings.coordinates,
        error: earnings.error || null,
      });

      // Задержка между запросами (учитывая геокодирование)
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    return {
      totalDistance: Math.round(totalDistance * 100) / 100,
      totalEarnings,
      pointsCount: pointsDetails.length,
      pointsDetails,
    };
  } catch (error) {
    console.error("Error calculating route earnings:", error);
    return {
      totalDistance: 0,
      totalEarnings: 0,
      pointsCount: 0,
      pointsDetails: [],
      error: error.message,
    };
  }
}

/**
 * Форматирует расстояние для вывода
 * @param {number} distanceKm - Расстояние в км
 * @returns {string}
 */
function formatDistance(distanceKm) {
  if (distanceKm < 1) {
    return `${Math.round(distanceKm * 1000)} м`;
  }
  return `${distanceKm.toFixed(2)} км`;
}

/**
 * Получает информацию о применяемом тарифе
 * @param {number} distanceKm - Расстояние в км
 * @returns {Object} { range: string, price: number }
 */
function getTariffInfo(distanceKm) {
  let prevMax = 0;

  for (const tariff of config.TARIFFS) {
    if (distanceKm <= tariff.maxDistance) {
      const range =
        tariff.maxDistance === Infinity
          ? `от ${prevMax} км`
          : `${prevMax}-${tariff.maxDistance} км`;

      return {
        range,
        price: tariff.price,
        distance: distanceKm,
      };
    }
    prevMax = tariff.maxDistance;
  }

  return null;
}

/**
 * Очищает кэш расстояний
 */
function clearCache() {
  distanceCache.clear();
  geocodeCache.clear();
  console.log("Distance and geocode caches cleared");
}

/**
 * Возвращает размер кэша
 * @returns {Object}
 */
function getCacheSize() {
  return {
    distance: distanceCache.size,
    geocode: geocodeCache.size,
  };
}

module.exports = {
  geocodeAddress,
  extractCoordinates,
  calculateRoadDistance,
  calculateStraightDistance,
  calculateDeliveryPrice,
  calculatePointEarnings,
  calculateRouteEarnings,
  formatDistance,
  getTariffInfo,
  clearCache,
  getCacheSize,
};
