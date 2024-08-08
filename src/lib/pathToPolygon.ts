import type { Point } from "../types/gds";

export function pathToPolygon(
  centerPoints: Point[],
  width: number,
  pathtype: number
): Point[] {
  if (centerPoints.length === 0) {
    return [];
  }

  if (width <= 0) {
    return centerPoints;
  }

  const halfWidth = width / 2;
  const leftEdge: Point[] = [];
  const rightEdge: Point[] = [];

  for (let i = 0; i < centerPoints.length; i++) {
    const current = centerPoints[i];
    if (!current) continue;

    const { perpX, perpY } = calculatePerpendicular(centerPoints, i);

    leftEdge.push({
      x: current.x + perpX * halfWidth,
      y: current.y + perpY * halfWidth,
    });
    rightEdge.push({
      x: current.x - perpX * halfWidth,
      y: current.y - perpY * halfWidth,
    });
  }

  const startCap = generateStartCap(centerPoints, halfWidth, pathtype);
  const endCap = generateEndCap(centerPoints, halfWidth, pathtype);

  const outline: Point[] = [];

  if (startCap.length > 0) {
    outline.push(...startCap);
  } else if (leftEdge[0]) {
    outline.push(leftEdge[0]);
  }

  outline.push(...leftEdge);

  if (endCap.length > 0) {
    outline.push(...endCap);
  }

  outline.push(...rightEdge.reverse());

  if (outline.length > 0 && outline[0]) {
    outline.push({ x: outline[0].x, y: outline[0].y });
  }

  return outline;
}

function calculatePerpendicular(
  centerPoints: Point[],
  index: number
): { perpX: number; perpY: number } {
  const current = centerPoints[index];
  if (!current) return { perpX: 0, perpY: 0 };

  let perpX = 0;
  let perpY = 0;

  if (index === 0) {
    const next = centerPoints[index + 1];
    if (next) {
      const dx = next.x - current.x;
      const dy = next.y - current.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        perpX = -dy / len;
        perpY = dx / len;
      }
    }
  } else if (index === centerPoints.length - 1) {
    const prev = centerPoints[index - 1];
    if (prev) {
      const dx = current.x - prev.x;
      const dy = current.y - prev.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        perpX = -dy / len;
        perpY = dx / len;
      }
    }
  } else {
    const prev = centerPoints[index - 1];
    const next = centerPoints[index + 1];
    if (prev && next) {
      const dx1 = current.x - prev.x;
      const dy1 = current.y - prev.y;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

      const dx2 = next.x - current.x;
      const dy2 = next.y - current.y;
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

      if (len1 > 0 && len2 > 0) {
        const perp1X = -dy1 / len1;
        const perp1Y = dx1 / len1;
        const perp2X = -dy2 / len2;
        const perp2Y = dx2 / len2;

        perpX = (perp1X + perp2X) / 2;
        perpY = (perp1Y + perp2Y) / 2;

        const perpLen = Math.sqrt(perpX * perpX + perpY * perpY);
        if (perpLen > 0) {
          perpX /= perpLen;
          perpY /= perpLen;
        }
      }
    }
  }

  return { perpX, perpY };
}

function generateStartCap(
  centerPoints: Point[],
  halfWidth: number,
  pathtype: number
): Point[] {
  if (pathtype === 0) {
    return [];
  }

  if (pathtype === 1) {
    const segments = 8;
    const first = centerPoints[0];
    const second = centerPoints[1];
    if (!first || !second) return [];

    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const angle = Math.atan2(dy, dx);

    const cap: Point[] = [];
    for (let j = 0; j <= segments; j++) {
      const theta = angle + Math.PI / 2 + (j / segments) * Math.PI;
      cap.push({
        x: first.x + Math.cos(theta) * halfWidth,
        y: first.y + Math.sin(theta) * halfWidth,
      });
    }
    return cap;
  }

  if (pathtype === 2) {
    const first = centerPoints[0];
    const second = centerPoints[1];
    if (!first || !second) return [];

    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return [];

    const extX = -(dx / len) * halfWidth;
    const extY = -(dy / len) * halfWidth;
    const perpX = -dy / len;
    const perpY = dx / len;

    return [
      {
        x: first.x + extX + perpX * halfWidth,
        y: first.y + extY + perpY * halfWidth,
      },
      {
        x: first.x + extX - perpX * halfWidth,
        y: first.y + extY - perpY * halfWidth,
      },
    ];
  }

  return [];
}

function generateEndCap(
  centerPoints: Point[],
  halfWidth: number,
  pathtype: number
): Point[] {
  if (pathtype === 0) {
    return [];
  }

  if (pathtype === 1) {
    const segments = 8;
    const last = centerPoints[centerPoints.length - 1];
    const secondLast = centerPoints[centerPoints.length - 2];
    if (!last || !secondLast) return [];

    const dx = last.x - secondLast.x;
    const dy = last.y - secondLast.y;
    const angle = Math.atan2(dy, dx);

    const cap: Point[] = [];
    for (let j = 0; j <= segments; j++) {
      const theta = angle - Math.PI / 2 + (j / segments) * Math.PI;
      cap.push({
        x: last.x + Math.cos(theta) * halfWidth,
        y: last.y + Math.sin(theta) * halfWidth,
      });
    }
    return cap;
  }

  if (pathtype === 2) {
    const last = centerPoints[centerPoints.length - 1];
    const secondLast = centerPoints[centerPoints.length - 2];
    if (!last || !secondLast) return [];

    const dx = last.x - secondLast.x;
    const dy = last.y - secondLast.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return [];

    const extX = (dx / len) * halfWidth;
    const extY = (dy / len) * halfWidth;
    const perpX = -dy / len;
    const perpY = dx / len;

    return [
      {
        x: last.x + extX - perpX * halfWidth,
        y: last.y + extY - perpY * halfWidth,
      },
      {
        x: last.x + extX + perpX * halfWidth,
        y: last.y + extY + perpY * halfWidth,
      },
    ];
  }

  return [];
}
