import type { NextApiRequest, NextApiResponse } from "next";
import type { Server as HTTPServer } from "http";
import { getSocketServer } from "@/lib/socket-server";

export const config = {
  api: {
    bodyParser: false
  }
};

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const socketServer = (res.socket as typeof res.socket & { server: HTTPServer }).server;
  getSocketServer(socketServer);
  res.end();
}
