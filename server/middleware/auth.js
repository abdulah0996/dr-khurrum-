import jwt from "jsonwebtoken";
import { models } from "../models/index.js";

function tokenOptions() {
  return {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "30m",
    issuer: "dr-khurrum-whatsapp-chatbot",
    audience: "clinic-staff",
    algorithm: "HS256"
  };
}

export function signAccessToken(user) {
  return jwt.sign(
    {
      userId: user.userId,
      email: user.email,
      role: user.role,
      name: user.name
    },
    process.env.JWT_ACCESS_SECRET,
    tokenOptions()
  );
}

export function publicUser(user) {
  if (!user) return null;
  return {
    userId: user.userId,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

export async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ message: "Authentication required." });

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
      issuer: tokenOptions().issuer,
      audience: tokenOptions().audience,
      algorithms: ["HS256"]
    });
    const user = await models.User.findOne({ userId: payload.userId, status: "Active" }).lean();
    if (!user) return res.status(401).json({ message: "User not found or inactive." });
    req.user = publicUser(user);
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ message: "You do not have permission to perform this action." });
    }
    return next();
  };
}
