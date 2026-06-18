#[tokio::main]
async fn main() {
    messaging_relayer::server::run()
        .await
        .expect("Server error");
}
