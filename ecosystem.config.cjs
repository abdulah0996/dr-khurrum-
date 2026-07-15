module.exports = {
  apps: [
    {
      name: "dr-khurrum-whatsapp-chatbot",
      script: "server/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 4000
      },
      max_memory_restart: "512M",
      time: true
    }
  ]
};
