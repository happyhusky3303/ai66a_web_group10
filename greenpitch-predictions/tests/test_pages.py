import pytest


@pytest.mark.parametrize(
    "path",
    ["/", "/match-center", "/match/123", "/login", "/my-matches"],
)
def test_html_pages_render(client, path):
    response = client.get(path)

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
