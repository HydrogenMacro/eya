//! Loopback-only SOCKS5 egress for server-rendered browser sessions.
//!
//! Chromium is configured to use this listener for every page connection. The
//! destination is resolved and pinned by the existing browser proxy before a
//! socket is opened, so browser requests inherit the relay's public-address
//! checks instead of using Chromium's resolver directly.

use crate::browser::Proxy;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinSet,
    time::timeout,
};

const MAX_CONNECTIONS: usize = 64;
const SOCKS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

pub struct Egress {
    pub address: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl Egress {
    pub async fn stop(&mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

impl Drop for Egress {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn start(proxy: Arc<Proxy>) -> std::io::Result<Egress> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let task = tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                    let proxy = proxy.clone();
                    connections.spawn(async move {
                        let _permit = permit;
                        let _ = relay_socks5(stream, proxy).await;
                    });
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
    });
    Ok(Egress { address, task })
}

async fn relay_socks5(mut client: TcpStream, proxy: Arc<Proxy>) -> Result<(), ()> {
    let handshake = timeout(SOCKS_HANDSHAKE_TIMEOUT, async {
        let mut greeting = [0u8; 2];
        client.read_exact(&mut greeting).await.map_err(|_| ())?;
        if greeting[0] != 5 || greeting[1] == 0 || greeting[1] > 16 {
            return Err(());
        }
        let mut methods = vec![0u8; greeting[1] as usize];
        client.read_exact(&mut methods).await.map_err(|_| ())?;
        if !methods.contains(&0) {
            client.write_all(&[5, 0xff]).await.map_err(|_| ())?;
            return Err(());
        }
        client.write_all(&[5, 0]).await.map_err(|_| ())?;

        let mut request = [0u8; 4];
        client.read_exact(&mut request).await.map_err(|_| ())?;
        if request[0] != 5 || request[1] != 1 || request[2] != 0 {
            write_socks_reply(&mut client, 7).await?;
            return Err(());
        }
        let host = match request[3] {
            1 => {
                let mut address = [0u8; 4];
                client.read_exact(&mut address).await.map_err(|_| ())?;
                std::net::Ipv4Addr::from(address).to_string()
            }
            4 => {
                let mut address = [0u8; 16];
                client.read_exact(&mut address).await.map_err(|_| ())?;
                format!("[{}]", std::net::Ipv6Addr::from(address))
            }
            3 => {
                let mut length = [0u8; 1];
                client.read_exact(&mut length).await.map_err(|_| ())?;
                if length[0] == 0 {
                    write_socks_reply(&mut client, 8).await?;
                    return Err(());
                }
                let mut name = vec![0u8; length[0] as usize];
                client.read_exact(&mut name).await.map_err(|_| ())?;
                let name = std::str::from_utf8(&name).map_err(|_| ())?;
                if name.is_empty()
                    || name.len() > 253
                    || name.bytes().any(|byte| byte.is_ascii_control())
                {
                    write_socks_reply(&mut client, 8).await?;
                    return Err(());
                }
                name.to_owned()
            }
            _ => {
                write_socks_reply(&mut client, 8).await?;
                return Err(());
            }
        };
        let mut port_bytes = [0u8; 2];
        client.read_exact(&mut port_bytes).await.map_err(|_| ())?;
        let port = u16::from_be_bytes(port_bytes);
        if !matches!(port, 80 | 443) {
            write_socks_reply(&mut client, 2).await?;
            return Err(());
        }
        Ok((host, port))
    })
    .await
    .map_err(|_| ())??;

    let (host, port) = handshake;
    let url = reqwest::Url::parse(&format!("https://{host}:{port}/")).map_err(|_| ())?;
    let addresses = match proxy.websocket_targets(&url).await {
        Ok(addresses) => addresses,
        Err(_) => {
            let _ = write_socks_reply(&mut client, 2).await;
            return Err(());
        }
    };
    let mut upstream = None;
    for address in addresses {
        match timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
            Ok(Ok(stream)) => {
                upstream = Some(stream);
                break;
            }
            _ => continue,
        }
    }
    let Some(mut upstream) = upstream else {
        let _ = write_socks_reply(&mut client, 5).await;
        return Err(());
    };
    write_socks_reply(&mut client, 0).await?;
    let _ = copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

async fn write_socks_reply(client: &mut TcpStream, status: u8) -> Result<(), ()> {
    client
        .write_all(&[5, status, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn socks_egress_rejects_private_ips_and_non_web_ports() {
        let proxy = Arc::new(Proxy::new().unwrap());
        let mut egress = start(proxy).await.unwrap();
        for request in [
            // SOCKS5 CONNECT to 127.0.0.1:443.
            vec![5, 1, 0, 1, 127, 0, 0, 1, 1, 187],
            // SOCKS5 CONNECT to public DNS name on an unapproved port.
            vec![
                5, 1, 0, 3, 12, b'e', b'x', b'a', b'm', b'p', b'l', b'e', b'.', b't', b'e', b's',
                b't', 1, 188,
            ],
        ] {
            let mut socket = TcpStream::connect(egress.address).await.unwrap();
            socket.write_all(&[5, 1, 0]).await.unwrap();
            let mut method = [0u8; 2];
            socket.read_exact(&mut method).await.unwrap();
            assert_eq!(method, [5, 0]);
            socket.write_all(&request).await.unwrap();
            let mut reply = [0u8; 10];
            socket.read_exact(&mut reply).await.unwrap();
            assert_eq!(
                reply[1], 2,
                "private destinations and non-web ports must be denied"
            );
        }
        egress.stop().await;
    }
}
